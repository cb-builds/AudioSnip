use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Host, Sample, SampleFormat, SizedSample, Stream, StreamConfig};

use super::{CaptureBackend, ChannelInfo, ChannelKind, StreamFormat};
use crate::audio::ring_buffer::RollingBuffer;

/// Duration of the fade-in applied to the very first frames a freshly
/// opened stream delivers. A newly opened WASAPI stream - loopback capture
/// especially - can carry a brief driver/endpoint "warm-up" transient (a
/// click/pop) before settling into a clean, correctly time-aligned signal;
/// this smooths that boundary at the source, in the capture callback
/// itself, rather than relying solely on the per-snapshot declick fade
/// (`commands::apply_declick_fade`), which can't reach it if the snapshot
/// window doesn't happen to start exactly at the stream's first sample.
const STREAM_START_FADE_MS: u64 = 30;

/// WASAPI capture backend (Windows only), built on `cpal`. Microphone/line
/// inputs are captured directly; opening an input stream on a render
/// (output) device instead makes cpal apply `AUDCLNT_STREAMFLAGS_LOOPBACK`
/// automatically, which is how system/application audio is captured. Kept
/// behind the `CaptureBackend` trait so a future Linux backend can be added
/// without touching shared audio/mixing/export code.
#[derive(Default)]
pub struct WasapiCaptureBackend {
    streams: HashMap<String, Stream>,
}

impl CaptureBackend for WasapiCaptureBackend {
    fn list_channels(&self) -> Vec<ChannelInfo> {
        let host = cpal::default_host();
        let mut channels = Vec::new();

        if let Ok(devices) = host.input_devices() {
            channels.extend(devices_to_channel_info(devices, ChannelKind::Input));
        }
        if let Ok(devices) = host.output_devices() {
            channels.extend(devices_to_channel_info(devices, ChannelKind::Output));
        }

        channels
    }

    fn start_capture(
        &mut self,
        channel_id: &str,
        buffer: Arc<RollingBuffer>,
    ) -> Result<StreamFormat, String> {
        let host = cpal::default_host();
        let (device, kind) = find_device(&host, channel_id)?;

        let config = match kind {
            ChannelKind::Input => device.default_input_config(),
            ChannelKind::Output => device.default_output_config(),
            // `find_device` only ever resolves against this backend's own
            // enumerated input/output devices - application sources are
            // captured entirely separately, via `process_loopback.rs`, and
            // never reach this backend at all (see `commands::start_capture`).
            ChannelKind::Application => {
                return Err(format!("'{channel_id}' is an application source, not a device"))
            }
        }
        .map_err(|err| format!("failed to read default config for '{channel_id}': {err}"))?;

        println!(
            "[audio::capture::wasapi] opening {kind:?} stream on '{device}' ({} ch @ {} Hz, {:?})",
            config.channels(),
            config.sample_rate(),
            config.sample_format(),
        );

        let format = StreamFormat {
            sample_rate: config.sample_rate(),
            channels: config.channels(),
        };
        let stream_config = config.config();
        let channel_id_owned = channel_id.to_string();

        let stream = match config.sample_format() {
            SampleFormat::F32 => {
                spawn_stream::<f32>(&device, stream_config, buffer, channel_id_owned.clone())
            }
            SampleFormat::I16 => {
                spawn_stream::<i16>(&device, stream_config, buffer, channel_id_owned.clone())
            }
            SampleFormat::U16 => {
                spawn_stream::<u16>(&device, stream_config, buffer, channel_id_owned.clone())
            }
            other => {
                return Err(format!(
                    "unsupported sample format '{other:?}' for '{channel_id}'"
                ))
            }
        }
        .map_err(|err| format!("failed to build input stream for '{channel_id}': {err}"))?;

        stream
            .play()
            .map_err(|err| format!("failed to start stream for '{channel_id}': {err}"))?;

        println!("[audio::capture::wasapi] capture started for '{channel_id}'");
        self.streams.insert(channel_id.to_string(), stream);
        Ok(format)
    }

    fn stop_capture(&mut self, channel_id: &str) -> Result<(), String> {
        match self.streams.remove(channel_id) {
            Some(stream) => {
                // Dropping the stream tears down the underlying WASAPI audio client.
                drop(stream);
                println!("[audio::capture::wasapi] capture stopped for '{channel_id}'");
                Ok(())
            }
            None => Err(format!("no active capture for channel '{channel_id}'")),
        }
    }
}

fn devices_to_channel_info(
    devices: impl Iterator<Item = Device>,
    kind: ChannelKind,
) -> Vec<ChannelInfo> {
    devices
        .filter_map(|device| device.id().ok().map(|id| (id.to_string(), device)))
        .map(|(id, device)| ChannelInfo {
            id,
            name: device.to_string(),
            kind,
            icon_base64: None,
        })
        .collect()
}

/// Looks a device up by ID across both input (microphone) and output
/// (loopback) devices, reporting which list it came from so the caller reads
/// the right default config and gets correct loopback-vs-direct behavior.
fn find_device(host: &Host, channel_id: &str) -> Result<(Device, ChannelKind), String> {
    if let Ok(mut devices) = host.input_devices() {
        if let Some(device) = devices.find(|d| d.id().is_ok_and(|id| id.to_string() == channel_id))
        {
            return Ok((device, ChannelKind::Input));
        }
    }

    if let Ok(mut devices) = host.output_devices() {
        if let Some(device) = devices.find(|d| d.id().is_ok_and(|id| id.to_string() == channel_id))
        {
            return Ok((device, ChannelKind::Output));
        }
    }

    Err(format!("no device found for channel '{channel_id}'"))
}

/// Builds and wires up the input stream for sample type `T`. The audio
/// callback only converts samples and writes them into the pre-allocated
/// lock-free rolling buffer (`RollingBuffer::write_from_iter`) - no
/// allocation happens on this thread, per the project's audio-safety
/// requirement. Once the buffer fills, new samples simply overwrite the
/// oldest ones; there's no "full" error case to handle.
///
/// The first `STREAM_START_FADE_MS` worth of frames are additionally faded
/// in via a lazy per-sample multiply on the conversion iterator itself -
/// still zero allocation, just arithmetic computed as `write_from_iter`
/// consumes the iterator - so a freshly started stream's opening transient
/// never reaches the ring buffer at full volume.
fn spawn_stream<T>(
    device: &cpal::Device,
    stream_config: StreamConfig,
    buffer: Arc<RollingBuffer>,
    channel_id: String,
) -> Result<Stream, cpal::Error>
where
    T: SizedSample + Send + 'static,
    f32: cpal::FromSample<T>,
{
    let channel_count = (stream_config.channels as usize).max(1);
    let fade_in_frames =
        ((STREAM_START_FADE_MS * stream_config.sample_rate as u64) / 1000) as usize;
    let frames_written = Arc::new(AtomicUsize::new(0));

    device.build_input_stream(
        stream_config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let frame_count = data.len() / channel_count;
            let start_frame = frames_written.fetch_add(frame_count, Ordering::Relaxed);

            if start_frame >= fade_in_frames {
                // Past the fade-in window - the overwhelming majority of
                // this stream's lifetime - so this stays exactly as cheap
                // as a plain conversion, with no extra branching per sample.
                buffer.write_from_iter(data.iter().map(|&sample| f32::from_sample(sample)));
            } else {
                buffer.write_from_iter(data.iter().enumerate().map(|(i, &sample)| {
                    let frame_index = start_frame + i / channel_count;
                    let value = f32::from_sample(sample);
                    if frame_index < fade_in_frames {
                        value * (frame_index as f32 / fade_in_frames as f32)
                    } else {
                        value
                    }
                }));
            }
        },
        move |err| eprintln!("[audio::capture::wasapi] stream error on '{channel_id}': {err}"),
        None,
    )
}
