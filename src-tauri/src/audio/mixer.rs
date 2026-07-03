use serde::{Deserialize, Deserializer};

/// Sample rate every track is resampled to before mixdown, so tracks
/// captured from devices with different native rates can still be summed
/// sample-for-sample.
pub const TARGET_SAMPLE_RATE: u32 = 48_000;

/// One captured track's raw interleaved PCM plus the format it was captured
/// at (needed to downmix to mono and resample before editing/mixing).
pub struct CapturedTrack {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
}

/// Deserializes a JSON number into a `u32`, rounding and clamping instead of
/// erroring out on a fractional value (e.g. `4445.7894` from a UI drag/typed
/// value that wasn't rounded before being sent over the IPC bridge). Millisecond-
/// level precision has no audible or visual significance for trim/fade points,
/// so this is a safe, permanent boundary sanitization rather than a workaround
/// for a specific caller - the frontend also rounds before sending (see
/// `commands.ts`'s `exportClip`), but this makes the backend robust even if a
/// future caller forgets to.
fn round_to_u32<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = f64::deserialize(deserializer)?;
    Ok(value.round().clamp(0.0, u32::MAX as f64) as u32)
}

/// Per-track editing parameters supplied by the React UI.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackEditParams {
    pub channel_id: String,
    /// Linear volume multiplier (1.0 = unity gain).
    pub volume: f32,
    #[serde(deserialize_with = "round_to_u32")]
    pub trim_start_ms: u32,
    /// `0` means "don't trim anything off the end".
    #[serde(deserialize_with = "round_to_u32")]
    pub trim_end_ms: u32,
    #[serde(deserialize_with = "round_to_u32")]
    pub fade_in_ms: u32,
    #[serde(deserialize_with = "round_to_u32")]
    pub fade_out_ms: u32,
}

/// Applies volume, trim, and fade in/out to one captured track, downmixing
/// to mono and resampling to [`TARGET_SAMPLE_RATE`] in the process, so every
/// edited track can be summed sample-for-sample in [`mixdown`] regardless of
/// its original format.
pub fn process_track(track: &CapturedTrack, params: &TrackEditParams) -> Vec<f32> {
    let mono = downmix_to_mono(&track.samples, track.channels.max(1) as usize);
    let resampled = resample_linear(&mono, track.sample_rate, TARGET_SAMPLE_RATE);

    let total_frames = resampled.len();
    let start = ms_to_frames(params.trim_start_ms).min(total_frames);
    let end = if params.trim_end_ms == 0 {
        total_frames
    } else {
        ms_to_frames(params.trim_end_ms).min(total_frames)
    }
    .max(start);

    let mut edited = resampled[start..end].to_vec();
    let len = edited.len();

    let fade_in_frames = ms_to_frames(params.fade_in_ms).min(len);
    for (i, sample) in edited.iter_mut().take(fade_in_frames).enumerate() {
        *sample *= i as f32 / fade_in_frames as f32;
    }

    let fade_out_frames = ms_to_frames(params.fade_out_ms).min(len);
    for i in 0..fade_out_frames {
        let gain = i as f32 / fade_out_frames as f32;
        edited[len - 1 - i] *= gain;
    }

    for sample in &mut edited {
        *sample *= params.volume;
    }

    edited
}

/// Sums processed (mono, [`TARGET_SAMPLE_RATE`]) tracks into one buffer, then
/// scales the whole mix down if its peak would exceed +/-1.0. This avoids
/// hard digital clipping without just naively clamping each sample, which
/// would otherwise introduce harsh distortion when multiple loud tracks
/// overlap.
pub fn mixdown(tracks: &[Vec<f32>]) -> Vec<f32> {
    let len = tracks.iter().map(Vec::len).max().unwrap_or(0);
    let mut mixed = vec![0.0_f32; len];

    for track in tracks {
        for (mixed_sample, &sample) in mixed.iter_mut().zip(track) {
            *mixed_sample += sample;
        }
    }

    let peak = mixed.iter().fold(0.0_f32, |acc, &s| acc.max(s.abs()));
    if peak > 1.0 {
        let gain = 1.0 / peak;
        for sample in &mut mixed {
            *sample *= gain;
        }
    }

    mixed
}

fn ms_to_frames(ms: u32) -> usize {
    ((ms as u64 * TARGET_SAMPLE_RATE as u64) / 1000) as usize
}

fn downmix_to_mono(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Simple linear-interpolation resampler. Good enough for aligning tracks
/// before mixdown; not a substitute for a proper band-limited resampler.
fn resample_linear(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || samples.is_empty() {
        return samples.to_vec();
    }

    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = ((samples.len() as f64) * ratio).round() as usize;

    (0..out_len)
        .map(|i| {
            let src_pos = i as f64 / ratio;
            let idx = src_pos.floor() as usize;
            let frac = (src_pos - idx as f64) as f32;
            let a = samples.get(idx).copied().unwrap_or(0.0);
            let b = samples.get(idx + 1).copied().unwrap_or(a);
            a + (b - a) * frac
        })
        .collect()
}
