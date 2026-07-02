use std::any::Any;
use std::sync::{Mutex, MutexGuard, RwLock, RwLockWriteGuard};

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::audio::capture::ChannelInfo;
use crate::audio::encoder;
use crate::audio::mixer::{self, TrackEditParams};
use crate::audio::ring_buffer::RollingBuffer;
use crate::hotkey;
use crate::state::AppState;

/// Sizing heuristic for the rolling buffer: assumes stereo audio at a common
/// WASAPI shared-mode rate. If a device's actual format is smaller than
/// this, the buffer just holds a bit more than the configured duration; if
/// larger (e.g. a high-rate multichannel device), it holds a bit less. Real
/// per-device sizing would need the format before the buffer exists, which
/// isn't known until the stream is opened.
const ASSUMED_SAMPLE_RATE: usize = 48_000;
const ASSUMED_CHANNELS: usize = 2;

fn capacity_for_duration(duration_secs: u32) -> usize {
    duration_secs as usize * ASSUMED_SAMPLE_RATE * ASSUMED_CHANNELS
}

/// Locks `mutex`, recovering the guard even if a *previous, unrelated*
/// panic poisoned it instead of propagating that poisoning forever. A
/// `Mutex` is only ever marked poisoned because some earlier critical
/// section panicked while holding it - the data itself is still structurally
/// valid (this app never leaves a lock-guarded value in a torn state, since
/// nothing here uses `mem::forget`/manual invariants across a panic), so
/// refusing to touch it again would just turn one past panic into an
/// indefinite, cascading failure for every future capture.
pub(crate) fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| {
        eprintln!(
            "[commands] recovered from a poisoned lock (a prior operation panicked while holding it) - continuing with the existing data"
        );
        poisoned.into_inner()
    })
}

/// `RwLock` equivalent of [`lock_or_recover`], for `active_channels`.
fn write_or_recover<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|poisoned| {
        eprintln!(
            "[commands] recovered from a poisoned RwLock (a prior operation panicked while holding it) - continuing with the existing data"
        );
        poisoned.into_inner()
    })
}

/// Extracts a human-readable message from a `catch_unwind` panic payload,
/// which only guarantees `Any + Send`, not any particular concrete type.
pub(crate) fn panic_message(payload: &Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

/// Short linear ramp (a few milliseconds) applied at the very start and end
/// of a channel's snapshot. Without this, the boundary between inserted
/// silence (when a channel doesn't have `target_frames` of real history yet)
/// or an arbitrary ring-buffer cut point and the real captured waveform is a
/// hard discontinuity, which is heard as a click/pop - most noticeable on
/// loopback-captured (e.g. browser) audio blended alongside a microphone
/// stream, since the two rarely land on a shared zero-crossing.
fn apply_declick_fade(samples: &mut [f32], channel_count: usize, sample_rate: u32) {
    const FADE_MS: f64 = 5.0;
    let channel_count = channel_count.max(1);
    let total_frames = samples.len() / channel_count;
    if total_frames == 0 {
        return;
    }

    let fade_frames = (((FADE_MS / 1000.0) * sample_rate as f64) as usize).min(total_frames / 2);
    if fade_frames == 0 {
        return;
    }

    for frame in 0..fade_frames {
        let gain = frame as f32 / fade_frames as f32;
        for ch in 0..channel_count {
            samples[frame * channel_count + ch] *= gain;
        }
    }

    for frame in 0..fade_frames {
        let gain = frame as f32 / fade_frames as f32;
        let target_frame = total_frames - 1 - frame;
        for ch in 0..channel_count {
            samples[target_frame * channel_count + ch] *= gain;
        }
    }
}

/// A snapshot of one channel's buffered samples, sent to the frontend for
/// waveform rendering, local preview playback, and editing. `sample_rate`
/// and `channels` are included so the frontend can interpret/play the raw
/// interleaved samples correctly.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSnapshot {
    pub channel_id: String,
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
}

/// The global hotkey's capture lifecycle, polled by the frontend via
/// `get_capture_status` instead of pushed as events - a `tauri-plugin-
/// global-shortcut` callback fires from the OS, entirely independent of
/// whether the webview has finished subscribing to anything, so an emitted
/// event has no delivery guarantee if it goes out before the frontend's
/// `listen()` call has registered. Polling a plain request/response command
/// has no such window: every check is a fresh, self-contained round trip
/// against whatever the backend currently holds.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CaptureStatus {
    /// No capture has completed since the last time the frontend consumed one.
    Idle,
    /// The hotkey fired and `snapshot_active_channels` is still running.
    Processing,
    /// Consumed exactly once: reading this via `get_capture_status` resets
    /// the backend's stored status back to `Idle`, so a slow poller can't
    /// see (or re-load) the same finished capture twice.
    Ready { snapshot: Vec<TrackSnapshot> },
    /// The capture panicked or otherwise failed - also consumed once, like `Ready`.
    Failed { message: String },
}

/// Pads or trims `buffer`'s current contents to exactly
/// `duration_secs * sample_rate` frames and declicks the boundary. Split out
/// from `snapshot_active_channels` so it can be wrapped in `catch_unwind`
/// independently per channel below - one channel's edge case (a partially
/// filled buffer, an unaligned sample count, an unexpected format) can't
/// sink the whole capture, and critically, the panic never reaches past this
/// point to poison the `buffers`/`formats` locks the caller is still
/// holding.
fn extract_channel_snapshot(
    buffer: &RollingBuffer,
    channel_count: usize,
    sample_rate: u32,
    duration_secs: u32,
) -> Vec<f32> {
    let mut samples = buffer.snapshot_all();
    let target_frames = ((duration_secs as f64) * (sample_rate as f64)).round().max(0.0) as usize;
    let available_frames = samples.len() / channel_count.max(1);

    if available_frames < target_frames {
        // Not enough real history yet - pad the front with silence so this
        // channel's window still starts exactly `duration_secs` before now,
        // chronologically locked with every other channel's snapshot.
        let missing_frames = target_frames - available_frames;
        let mut padded = vec![0.0_f32; missing_frames * channel_count];
        padded.extend_from_slice(&samples);
        samples = padded;
    } else if available_frames > target_frames {
        // More history than the configured window - keep only the most
        // recent `target_frames` so every channel's snapshot ends at the
        // same instant and spans the same duration.
        let excess_frames = available_frames - target_frames;
        samples.drain(..excess_frames * channel_count);
    }

    // Smooth the very start/end of the window so the silence/audio seam (or
    // an arbitrary ring-buffer cut point) never cracks.
    apply_declick_fade(&mut samples, channel_count, sample_rate);
    samples
}

/// Takes a non-destructive snapshot of every active channel's rolling
/// buffer, strictly aligned to the exact same real-world window: the
/// configured buffer duration ending at this very instant (i.e.
/// `[now - buffer_duration_secs, now]`). Every returned track therefore has
/// exactly `buffer_duration_secs * its own sample_rate` frames - if a
/// channel doesn't have that much real history yet (it started capturing
/// recently), its front is padded with silence; if it somehow has more
/// (its buffer's actual capacity in time exceeds the configured duration),
/// the oldest excess is dropped. This guarantees every channel's clip is
/// the same length and locked to the same end instant, with no drift.
///
/// Also caches a copy in `AppState.last_snapshot` so `export_clip` later
/// reuses exactly what the user saw/edited instead of whatever the live
/// buffer has moved on to by export time.
///
/// This is a plain function (not a `#[tauri::command]`) so both the
/// `capture_snapshot` command (frontend-invoked) and the global hotkey
/// handler in `hotkey.rs` (Rust-invoked) can share the exact same logic.
/// Taking the snapshot never pauses, clears, or otherwise disturbs the
/// ongoing background recording.
///
/// Every step is logged and every channel's extraction is individually
/// panic-safe (see `extract_channel_snapshot`'s docs): a channel that fails
/// falls back to a silent clip of the expected length instead of aborting
/// the whole capture, so this function always returns and the caller can
/// always broadcast a result to the frontend - it never hangs and never
/// leaves a lock poisoned for the next call.
pub fn snapshot_active_channels(state: &AppState) -> Vec<TrackSnapshot> {
    println!("[capture] snapshot_active_channels: acquiring buffers lock...");
    let buffers = lock_or_recover(&state.buffers);
    println!(
        "[capture] snapshot_active_channels: buffers lock acquired ({} channel(s) active)",
        buffers.len()
    );

    println!("[capture] snapshot_active_channels: acquiring formats lock...");
    let formats = lock_or_recover(&state.formats);
    println!("[capture] snapshot_active_channels: formats lock acquired");

    let duration_secs = *lock_or_recover(&state.buffer_duration_secs);
    println!("[capture] snapshot_active_channels: buffer_duration_secs = {duration_secs}");

    let snapshot: Vec<TrackSnapshot> = buffers
        .iter()
        .map(|(channel_id, buffer)| {
            println!("[capture] channel '{channel_id}': extracting samples...");
            let format = formats.get(channel_id).copied();
            let sample_rate = format.map(|f| f.sample_rate).unwrap_or(mixer::TARGET_SAMPLE_RATE);
            let channels = format.map(|f| f.channels).unwrap_or(1);
            let channel_count = (channels as usize).max(1);

            let extraction = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                extract_channel_snapshot(buffer, channel_count, sample_rate, duration_secs)
            }));

            let samples = match extraction {
                Ok(samples) => {
                    println!(
                        "[capture] channel '{channel_id}': extracted {} sample(s) at {sample_rate}Hz/{channels}ch",
                        samples.len()
                    );
                    samples
                }
                Err(panic_payload) => {
                    let message = panic_message(&panic_payload);
                    eprintln!(
                        "[capture] channel '{channel_id}': extraction panicked ({message}) - falling back to a silent clip so the overall capture still completes"
                    );
                    let target_frames =
                        ((duration_secs as f64) * (sample_rate as f64)).round().max(0.0) as usize;
                    vec![0.0_f32; target_frames * channel_count]
                }
            };

            TrackSnapshot {
                channel_id: channel_id.clone(),
                samples,
                sample_rate,
                channels,
            }
        })
        .collect();

    drop(buffers);
    drop(formats);
    println!("[capture] snapshot_active_channels: buffers/formats locks released");

    println!("[capture] snapshot_active_channels: acquiring last_snapshot lock to cache results...");
    let mut last_snapshot = lock_or_recover(&state.last_snapshot);
    for track in &snapshot {
        last_snapshot.insert(track.channel_id.clone(), track.samples.clone());
    }
    drop(last_snapshot);

    println!(
        "[capture] snapshot_active_channels: done - {} channel(s) captured, ready to broadcast",
        snapshot.len()
    );
    snapshot
}

#[tauri::command]
pub fn list_channels(state: State<AppState>) -> Vec<ChannelInfo> {
    lock_or_recover(&state.capture).list_channels()
}

#[tauri::command]
pub fn start_capture(state: State<AppState>, channel_id: String) -> Result<(), String> {
    let duration_secs = *lock_or_recover(&state.buffer_duration_secs);
    let buffer = RollingBuffer::new(capacity_for_duration(duration_secs));

    let format = lock_or_recover(&state.capture).start_capture(&channel_id, buffer.clone())?;

    lock_or_recover(&state.formats).insert(channel_id.clone(), format);
    lock_or_recover(&state.buffers).insert(channel_id.clone(), buffer);
    write_or_recover(&state.active_channels).push(channel_id);

    Ok(())
}

#[tauri::command]
pub fn stop_capture(state: State<AppState>, channel_id: String) -> Result<(), String> {
    lock_or_recover(&state.capture).stop_capture(&channel_id)?;
    lock_or_recover(&state.buffers).remove(&channel_id);
    lock_or_recover(&state.formats).remove(&channel_id);
    write_or_recover(&state.active_channels).retain(|id| id != &channel_id);

    Ok(())
}

#[tauri::command]
pub fn capture_snapshot(state: State<AppState>) -> Vec<TrackSnapshot> {
    snapshot_active_channels(&state)
}

/// Polled by the frontend (instead of listening for a push event) to learn
/// whether the global hotkey has started, finished, or failed a capture.
/// `Ready`/`Failed` are consumed on read - the stored status resets to
/// `Idle` as part of this call - so a poll loop only ever sees each
/// finished capture once, no matter how many times it checks afterward.
#[tauri::command]
pub fn get_capture_status(state: State<AppState>) -> CaptureStatus {
    let mut status = lock_or_recover(&state.capture_status);
    match &*status {
        CaptureStatus::Idle => CaptureStatus::Idle,
        CaptureStatus::Processing => CaptureStatus::Processing,
        CaptureStatus::Ready { .. } | CaptureStatus::Failed { .. } => {
            std::mem::replace(&mut *status, CaptureStatus::Idle)
        }
    }
}

/// Returns the current rolling-buffer duration in seconds.
#[tauri::command]
pub fn get_buffer_duration(state: State<AppState>) -> u32 {
    *lock_or_recover(&state.buffer_duration_secs)
}

/// Sets the rolling-buffer duration (seconds) used for channels started
/// after this call. Does not resize buffers already in use by an active
/// capture - stop and restart a channel to pick up the new duration.
#[tauri::command]
pub fn set_buffer_duration(state: State<AppState>, seconds: u32) -> Result<(), String> {
    if seconds == 0 {
        return Err("buffer duration must be at least 1 second".into());
    }
    *lock_or_recover(&state.buffer_duration_secs) = seconds;
    Ok(())
}

/// Applies each track's edit params to its cached captured audio, mixes the
/// results down without clipping, encodes the mix as MP3, and prompts the
/// user with a native save dialog. Returns `Ok(None)` (not an error) if the
/// user cancels the dialog.
#[tauri::command]
pub fn export_clip(
    app: AppHandle,
    state: State<AppState>,
    tracks: Vec<TrackEditParams>,
) -> Result<Option<String>, String> {
    if tracks.is_empty() {
        return Err("no tracks selected for export".into());
    }

    let processed = {
        let last_snapshot = lock_or_recover(&state.last_snapshot);
        let formats = lock_or_recover(&state.formats);

        tracks
            .iter()
            .map(|params| {
                let samples = last_snapshot.get(&params.channel_id).ok_or_else(|| {
                    format!("no captured audio for channel '{}'", params.channel_id)
                })?;
                let format = formats
                    .get(&params.channel_id)
                    .ok_or_else(|| format!("unknown format for channel '{}'", params.channel_id))?;

                let captured = mixer::CapturedTrack {
                    samples: samples.clone(),
                    sample_rate: format.sample_rate,
                    channels: format.channels,
                };
                Ok(mixer::process_track(&captured, params))
            })
            .collect::<Result<Vec<_>, String>>()?
    };

    let mixed = mixer::mixdown(&processed);
    let mp3_bytes = encoder::encode_mp3(&mixed, mixer::TARGET_SAMPLE_RATE)
        .map_err(|err| format!("failed to encode MP3: {err}"))?;

    let Some(file_path) = app
        .dialog()
        .file()
        .add_filter("MP3 Audio", &["mp3"])
        .set_file_name("clip.mp3")
        .blocking_save_file()
    else {
        println!("[export] user cancelled the save dialog");
        return Ok(None);
    };

    let path = file_path
        .into_path()
        .map_err(|err| format!("invalid save path: {err}"))?;

    std::fs::write(&path, mp3_bytes).map_err(|err| format!("failed to write MP3 file: {err}"))?;

    println!("[export] wrote clip to '{}'", path.display());
    Ok(Some(path.display().to_string()))
}

/// Immediately resets every active channel's rolling buffer back to empty
/// and clears the cached snapshot used by `export_clip`. Called when the set
/// of captured devices changes, so stale audio from the old device
/// selection never gets blended with newly-captured audio.
#[tauri::command]
pub fn flush_buffers(state: State<AppState>) {
    for buffer in lock_or_recover(&state.buffers).values() {
        buffer.clear();
    }
    lock_or_recover(&state.last_snapshot).clear();
    println!("[commands] flushed all buffered audio");
}

/// Returns the accelerator string of the currently registered global hotkey.
#[tauri::command]
pub fn get_hotkey(state: State<AppState>) -> String {
    lock_or_recover(&state.current_hotkey).clone()
}

/// Unregisters the current global hotkey and attempts to register `shortcut`
/// in its place. If the new shortcut fails to register (e.g. it's already
/// taken by another application), the previous binding is restored so the
/// app is never left without a working hotkey, and an error is returned so
/// the UI can notify the user.
#[tauri::command]
pub fn update_hotkey(app: AppHandle, state: State<AppState>, shortcut: String) -> Result<(), String> {
    let global_shortcut = app.global_shortcut();
    let mut current = lock_or_recover(&state.current_hotkey);

    if let Err(err) = global_shortcut.unregister(current.as_str()) {
        eprintln!("[hotkey] failed to unregister previous shortcut '{current}': {err}");
    }

    if let Err(err) = global_shortcut.on_shortcut(shortcut.as_str(), hotkey::on_hotkey_triggered) {
        if let Err(restore_err) =
            global_shortcut.on_shortcut(current.as_str(), hotkey::on_hotkey_triggered)
        {
            eprintln!("[hotkey] failed to restore previous shortcut '{current}': {restore_err}");
        }
        return Err(format!("failed to register hotkey '{shortcut}': {err}"));
    }

    println!("[hotkey] updated global hotkey from '{current}' to '{shortcut}'");
    *current = shortcut;
    Ok(())
}
