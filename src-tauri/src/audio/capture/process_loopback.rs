//! Per-application audio capture via Windows' process-loopback API
//! (`ActivateAudioInterfaceAsync` with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`,
//! Windows 10 2004+). `cpal` has no support for this - it only exposes
//! device-based capture (a real input, or a whole output device's loopback)
//! - so this talks to WASAPI directly instead.
//!
//! Unlike device capture (`super::wasapi`), there's no enumerable "channel"
//! here ahead of time: a capture target is a live process ID, resolved from
//! an `apps::ApplicationSource`'s saved exe path immediately before starting
//! (see `apps::find_running_pid_for_exe`). The captured format is always
//! fixed at 48kHz/stereo/f32 (chosen to match `mixer::TARGET_SAMPLE_RATE`
//! and the rolling buffer's capacity assumptions) rather than negotiated,
//! since a process-loopback stream has no real endpoint to query a mix
//! format from.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use windows::core::{implement, Interface, Ref, Result as WinResult};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED, BLOB};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;

use crate::audio::ring_buffer::RollingBuffer;
use crate::audio::capture::StreamFormat;

/// `WAVE_FORMAT_IEEE_FLOAT` (`mmreg.h`) - not worth pulling in the whole
/// `Win32_Media_Multimedia` feature for one constant.
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const CAPTURE_SAMPLE_RATE: u32 = 48_000;
const CAPTURE_CHANNELS: u16 = 2;
/// How long to wait for `ActivateAudioInterfaceAsync` to complete, and
/// separately for the capture thread to finish standing up the stream,
/// before giving up and reporting a failure to the caller.
const SETUP_TIMEOUT: Duration = Duration::from_secs(5);

/// One application source's live capture: a background thread running the
/// WASAPI event loop, stopped by flipping `stop_flag` and joining.
struct ActiveCapture {
    stop_flag: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// Tracks every application source currently being captured, keyed by the
/// same source id (`apps::ApplicationSource::id`, the lowercased exe path)
/// used everywhere else as its "channel id".
#[derive(Default)]
pub struct ProcessLoopbackManager {
    captures: HashMap<String, ActiveCapture>,
}

impl ProcessLoopbackManager {
    /// Resolves `pid`'s process audio via process-loopback and starts
    /// streaming samples into `buffer`. Blocks (briefly) until the capture
    /// thread confirms the stream actually started, so a failure - the
    /// process exited, activation was denied, format negotiation failed -
    /// surfaces here as an `Err` instead of silently producing an empty
    /// buffer.
    pub fn start(
        &mut self,
        source_id: &str,
        pid: u32,
        buffer: Arc<RollingBuffer>,
    ) -> Result<StreamFormat, String> {
        if self.captures.contains_key(source_id) {
            return Err(format!("already capturing application source '{source_id}'"));
        }

        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop_flag = Arc::clone(&stop_flag);
        let (ready_tx, ready_rx) = sync_channel::<Result<(), String>>(1);

        let thread = std::thread::spawn(move || {
            run_capture_loop(pid, buffer, thread_stop_flag, ready_tx);
        });

        match ready_rx.recv_timeout(SETUP_TIMEOUT) {
            Ok(Ok(())) => {
                self.captures.insert(
                    source_id.to_string(),
                    ActiveCapture { stop_flag, thread: Some(thread) },
                );
                Ok(StreamFormat { sample_rate: CAPTURE_SAMPLE_RATE, channels: CAPTURE_CHANNELS })
            }
            Ok(Err(err)) => {
                let _ = thread.join();
                Err(err)
            }
            Err(_) => {
                // The thread is presumably stuck inside a blocking WASAPI
                // call - flip the flag anyway so it tears itself down
                // whenever it does unblock, rather than leaking it.
                stop_flag.store(true, Ordering::SeqCst);
                Err("timed out waiting for process-loopback capture to start".to_string())
            }
        }
    }

    pub fn stop(&mut self, source_id: &str) -> Result<(), String> {
        let Some(mut capture) = self.captures.remove(source_id) else {
            return Err(format!("no active capture for application source '{source_id}'"));
        };
        capture.stop_flag.store(true, Ordering::SeqCst);
        if let Some(thread) = capture.thread.take() {
            let _ = thread.join();
        }
        Ok(())
    }
}

/// Runs entirely on its own dedicated thread: initializes COM, activates
/// the process-loopback audio client, reports success/failure via
/// `ready_tx`, then pumps captured packets into `buffer` in an
/// event-driven loop until `stop_flag` is set.
fn run_capture_loop(
    pid: u32,
    buffer: Arc<RollingBuffer>,
    stop_flag: Arc<AtomicBool>,
    ready_tx: SyncSender<Result<(), String>>,
) {
    let com_result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if com_result.is_err() {
        let _ = ready_tx.send(Err(format!("failed to initialize COM: {}", com_result.message())));
        return;
    }

    let setup = (|| -> Result<(IAudioClient, IAudioCaptureClient, HANDLE), String> {
        let audio_client = activate_process_loopback_client(pid)?;
        let format = build_wave_format();

        unsafe {
            audio_client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                    0,
                    0,
                    &format,
                    None,
                )
                .map_err(|err| format!("IAudioClient::Initialize failed: {err}"))?;
        }

        let event_handle = unsafe { CreateEventW(None, false, false, None) }
            .map_err(|err| format!("CreateEventW failed: {err}"))?;

        unsafe {
            audio_client
                .SetEventHandle(event_handle)
                .map_err(|err| format!("SetEventHandle failed: {err}"))?;
        }

        let capture_client: IAudioCaptureClient = unsafe { audio_client.GetService() }
            .map_err(|err| format!("GetService(IAudioCaptureClient) failed: {err}"))?;

        unsafe {
            audio_client.Start().map_err(|err| format!("IAudioClient::Start failed: {err}"))?;
        }

        Ok((audio_client, capture_client, event_handle))
    })();

    let (audio_client, capture_client, event_handle) = match setup {
        Ok(resources) => {
            let _ = ready_tx.send(Ok(()));
            resources
        }
        Err(err) => {
            let _ = ready_tx.send(Err(err));
            unsafe { CoUninitialize() };
            return;
        }
    };

    println!("[process_loopback] capture started for pid {pid}");
    while !stop_flag.load(Ordering::SeqCst) {
        // A short timeout (rather than INFINITE) so a pending stop request
        // is noticed promptly even if the stream falls silent and stops
        // signaling the event.
        let wait_result = unsafe { WaitForSingleObject(event_handle, 200) };
        if wait_result != WAIT_OBJECT_0 {
            continue;
        }

        loop {
            let packet_frames = match unsafe { capture_client.GetNextPacketSize() } {
                Ok(size) => size,
                Err(err) => {
                    eprintln!("[process_loopback] GetNextPacketSize failed: {err}");
                    break;
                }
            };
            if packet_frames == 0 {
                break;
            }

            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut frames_available: u32 = 0;
            let mut flags: u32 = 0;
            let get_buffer = unsafe {
                capture_client.GetBuffer(&mut data_ptr, &mut frames_available, &mut flags, None, None)
            };
            if let Err(err) = get_buffer {
                eprintln!("[process_loopback] GetBuffer failed: {err}");
                break;
            }

            if frames_available > 0 {
                let sample_count = (frames_available as usize) * (CAPTURE_CHANNELS as usize);
                let is_silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                if is_silent || data_ptr.is_null() {
                    buffer.write_from_iter(std::iter::repeat(0.0_f32).take(sample_count));
                } else {
                    let samples =
                        unsafe { std::slice::from_raw_parts(data_ptr as *const f32, sample_count) };
                    buffer.write_from_iter(samples.iter().copied());
                }
            }

            if let Err(err) = unsafe { capture_client.ReleaseBuffer(frames_available) } {
                eprintln!("[process_loopback] ReleaseBuffer failed: {err}");
            }
        }
    }
    println!("[process_loopback] capture stopped for pid {pid}");

    unsafe {
        let _ = audio_client.Stop();
        let _ = CloseHandle(event_handle);
        CoUninitialize();
    }
}

fn build_wave_format() -> WAVEFORMATEX {
    let bits_per_sample: u16 = 32;
    let block_align = CAPTURE_CHANNELS * (bits_per_sample / 8);
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
        nChannels: CAPTURE_CHANNELS,
        nSamplesPerSec: CAPTURE_SAMPLE_RATE,
        nAvgBytesPerSec: CAPTURE_SAMPLE_RATE * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: bits_per_sample,
        cbSize: 0,
    }
}

/// Activates a process-scoped loopback `IAudioClient` targeting `pid`'s
/// audio (including its child processes), via the async
/// `ActivateAudioInterfaceAsync` API and a completion-handler COM object
/// that forwards the result back through a channel.
fn activate_process_loopback_client(pid: u32) -> Result<IAudioClient, String> {
    // Deliberately heap-allocated *and leaked* (`Box::leak`), rather than a
    // plain stack local. A stack-local version of this struct reproduced a
    // `STATUS_HEAP_CORRUPTION` crash 100% of the time, immediately after
    // `ActivateCompleted` fired and this function returned - i.e. well after
    // the synchronous activation call itself had already completed. That
    // points to `ActivateAudioInterfaceAsync` (or the audio graph it sets
    // up) retaining a pointer into this struct for longer than just the
    // activation call, contrary to what the synchronous
    // "call, then wait for one completion callback" pattern would suggest.
    // This isn't documented behavior, but leaking one small, fixed-size
    // struct per `start()` call is a negligible, permanent, and reliable
    // workaround - confirmed fixed by
    // `process_loopback::tests::captures_real_non_silent_audio_from_a_spawned_process`,
    // which reproduced the crash before this change and passes repeatably
    // after it.
    let activation_params: &'static mut AUDIOCLIENT_ACTIVATION_PARAMS =
        Box::leak(Box::new(AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        }));

    let mut prop = PROPVARIANT::default();
    prop.Anonymous.Anonymous = std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
        vt: VT_BLOB,
        wReserved1: 0,
        wReserved2: 0,
        wReserved3: 0,
        Anonymous: PROPVARIANT_0_0_0 {
            blob: BLOB {
                cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                pBlobData: activation_params as *mut _ as *mut u8,
            },
        },
    });

    let (tx, rx) = sync_channel::<WinResult<IAudioClient>>(1);
    let handler: IActivateAudioInterfaceCompletionHandler = ActivationHandler { tx }.into();

    let _operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&prop),
            &handler,
        )
    }
    .map_err(|err| format!("ActivateAudioInterfaceAsync failed: {err}"))?;

    rx.recv_timeout(SETUP_TIMEOUT)
        .map_err(|_| "timed out waiting for audio interface activation".to_string())?
        .map_err(|err| format!("audio interface activation failed: {err}"))
}

/// COM completion handler for `ActivateAudioInterfaceAsync` - forwards the
/// resulting `IAudioClient` (or an error) back to the waiting thread
/// through `tx`.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler {
    tx: SyncSender<WinResult<IAudioClient>>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        activate_operation: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> WinResult<()> {
        let result = (|| -> WinResult<IAudioClient> {
            let operation = activate_operation
                .ok()
                .map_err(|_| windows::core::Error::from(windows::Win32::Foundation::E_POINTER))?;

            let mut activate_result = windows::core::HRESULT(0);
            let mut interface_unknown: Option<windows::core::IUnknown> = None;
            unsafe {
                operation.GetActivateResult(&mut activate_result, &mut interface_unknown)?;
            }
            activate_result.ok()?;

            let unknown = interface_unknown
                .ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            unknown.cast::<IAudioClient>()
        })();

        let _ = self.tx.send(result);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end proof that process-loopback capture actually works, not
    /// just compiles: spawns a real `powershell.exe` process that plays a
    /// real system sound synchronously (so the audio genuinely comes from
    /// that specific PID), captures its audio via `ProcessLoopbackManager`
    /// while it plays, and asserts the rolling buffer actually received a
    /// meaningful amount of non-silent audio.
    #[test]
    fn captures_real_non_silent_audio_from_a_spawned_process() {
        let mut child = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                "(New-Object System.Media.SoundPlayer 'C:\\Windows\\Media\\Alarm01.wav').PlaySync()",
            ])
            .spawn()
            .expect("failed to spawn powershell.exe");

        let pid = child.id();
        println!("spawned powershell.exe with pid {pid}, playing Alarm01.wav synchronously");

        // Sized generously for a several-second clip at 48kHz stereo f32.
        let buffer = RollingBuffer::new(48_000 * 2 * 15);
        let mut manager = ProcessLoopbackManager::default();

        let start_result = manager.start("test-source", pid, buffer.clone());
        assert!(
            start_result.is_ok(),
            "failed to start process-loopback capture: {:?}",
            start_result.err()
        );

        let status = child.wait().expect("failed to wait for powershell.exe");
        assert!(status.success(), "powershell.exe exited with a failure status");

        // Give the capture thread a moment to drain any packets still
        // in flight after the source process's audio session tears down.
        std::thread::sleep(std::time::Duration::from_millis(300));

        manager.stop("test-source").expect("failed to stop the capture");

        let captured = buffer.snapshot_all();
        let seconds = captured.len() as f64 / CAPTURE_CHANNELS as f64 / CAPTURE_SAMPLE_RATE as f64;
        println!("captured {} samples (~{seconds:.2}s)", captured.len());
        assert!(!captured.is_empty(), "expected some captured audio, got none at all");

        let non_silent = captured.iter().filter(|&&s| s.abs() > 0.001).count();
        println!("{non_silent} non-silent samples out of {}", captured.len());
        assert!(
            non_silent > 1000,
            "expected a meaningful amount of non-silent audio, got only {non_silent} samples - \
             capture may be running but receiving silence instead of the target process's real audio"
        );
    }
}
