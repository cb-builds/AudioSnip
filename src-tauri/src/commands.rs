use std::any::Any;
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::audio::capture::ChannelInfo;
use crate::audio::encoder;
use crate::audio::mixer::{self, TrackEditParams};
use crate::audio::ring_buffer::RollingBuffer;
use crate::hotkey;
use crate::settings_store;
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

/// Read-only counterpart of [`write_or_recover`].
pub(crate) fn read_or_recover<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| {
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
    /// A clip was already loaded when this capture ran - `snapshot` is also
    /// staged in `AppState.pending_capture` so the frontend's own themed
    /// confirmation modal can decide whether to commit it (see
    /// `confirm_capture_overwrite`/`discard_pending_capture`). Consumed once,
    /// like `Ready`.
    Conflict { snapshot: Vec<TrackSnapshot> },
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
///
/// `duration_secs` is a real (not necessarily whole-number) duration - see
/// `snapshot_active_channels`, which computes it dynamically as "how much
/// audio has actually been recorded so far" rather than always the
/// configured buffer maximum, so a snip taken shortly after opening the app
/// (or resetting the buffer) reflects its true, shorter length.
fn extract_channel_snapshot(
    buffer: &RollingBuffer,
    channel_count: usize,
    sample_rate: u32,
    duration_secs: f64,
) -> Vec<f32> {
    let mut samples = buffer.snapshot_all();
    let target_frames = (duration_secs * (sample_rate as f64)).round().max(0.0) as usize;
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
/// buffer, aligned to the same real-world window ending at this very
/// instant. The window's length is dynamic, not always the configured
/// buffer maximum: it's the *actual* amount of audio recorded so far (across
/// every active channel, capped at `buffer_duration_secs`), so a snip taken
/// shortly after opening the app or resetting the buffer reflects its true,
/// shorter length instead of always spanning the full configured duration.
/// Every channel is padded/trimmed to that same effective length so every
/// returned track stays the same size and locked to the same end instant,
/// with no drift.
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
///
/// Does *not* cache the result into `AppState.last_snapshot` - see
/// `commit_snapshot`, called separately so a caller (namely
/// `hotkey::trigger_capture`'s overwrite-confirmation flow) can hold a
/// snapshot in memory and decide later whether to actually commit it.
pub fn snapshot_active_channels_uncached(state: &AppState) -> Vec<TrackSnapshot> {
    println!("[capture] snapshot_active_channels: acquiring buffers lock...");
    let buffers = lock_or_recover(&state.buffers);
    println!(
        "[capture] snapshot_active_channels: buffers lock acquired ({} channel(s) active)",
        buffers.len()
    );

    println!("[capture] snapshot_active_channels: acquiring formats lock...");
    let formats = lock_or_recover(&state.formats);
    println!("[capture] snapshot_active_channels: formats lock acquired");

    let configured_duration_secs = *lock_or_recover(&state.buffer_duration_secs);

    // How much real audio has actually accumulated so far, across every
    // active channel - the longest of them sets the effective window length
    // (still capped at the configured maximum), so a channel that's been
    // recording longer than another doesn't get truncated down to the
    // newer one's shorter history.
    let mut max_available_secs = 0.0_f64;
    for (channel_id, buffer) in buffers.iter() {
        let format = formats.get(channel_id).copied();
        let sample_rate = format.map(|f| f.sample_rate).unwrap_or(mixer::TARGET_SAMPLE_RATE);
        let channels = format.map(|f| f.channels).unwrap_or(1);
        let channel_count = (channels as usize).max(1);
        let available_secs =
            buffer.available_len() as f64 / channel_count as f64 / (sample_rate.max(1) as f64);
        max_available_secs = max_available_secs.max(available_secs);
    }
    let duration_secs = max_available_secs.min(configured_duration_secs as f64);
    println!(
        "[capture] snapshot_active_channels: effective duration = {duration_secs:.3}s (configured max = {configured_duration_secs}s)"
    );

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
                    let target_frames = (duration_secs * (sample_rate as f64)).round().max(0.0) as usize;
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

    println!(
        "[capture] snapshot_active_channels: done - {} channel(s) captured, ready to broadcast",
        snapshot.len()
    );
    snapshot
}

/// Writes `snapshot` into `AppState.last_snapshot`, so `export_clip` later
/// reuses exactly what the user saw/edited instead of whatever the live
/// buffer has moved on to by export time. Split out from
/// `snapshot_active_channels_uncached` so a caller can inspect/hold a
/// snapshot before deciding whether it should actually replace what's
/// currently loaded (see `hotkey::trigger_capture`'s overwrite confirmation).
pub fn commit_snapshot(state: &AppState, snapshot: &[TrackSnapshot]) {
    let mut last_snapshot = lock_or_recover(&state.last_snapshot);
    for track in snapshot {
        last_snapshot.insert(track.channel_id.clone(), track.samples.clone());
    }
}

/// Convenience wrapper used by the `capture_snapshot` command: takes a
/// snapshot and immediately commits it, with no overwrite confirmation -
/// that gating only applies to the hotkey/tray/button capture flow (see
/// `hotkey::trigger_capture`), not this direct, synchronous command.
pub fn snapshot_active_channels(state: &AppState) -> Vec<TrackSnapshot> {
    let snapshot = snapshot_active_channels_uncached(state);
    commit_snapshot(state, &snapshot);
    snapshot
}

#[tauri::command]
pub fn list_channels(state: State<AppState>) -> Vec<ChannelInfo> {
    lock_or_recover(&state.capture).list_channels()
}

#[tauri::command]
pub fn start_capture(app: AppHandle, state: State<AppState>, channel_id: String) -> Result<(), String> {
    let duration_secs = *lock_or_recover(&state.buffer_duration_secs);
    let buffer = RollingBuffer::new(capacity_for_duration(duration_secs));

    let format = lock_or_recover(&state.capture).start_capture(&channel_id, buffer.clone())?;

    lock_or_recover(&state.formats).insert(channel_id.clone(), format);
    lock_or_recover(&state.buffers).insert(channel_id.clone(), buffer);
    write_or_recover(&state.active_channels).push(channel_id);

    settings_store::save(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn stop_capture(app: AppHandle, state: State<AppState>, channel_id: String) -> Result<(), String> {
    lock_or_recover(&state.capture).stop_capture(&channel_id)?;
    lock_or_recover(&state.buffers).remove(&channel_id);
    lock_or_recover(&state.formats).remove(&channel_id);
    write_or_recover(&state.active_channels).retain(|id| id != &channel_id);

    settings_store::save(&app, &state);
    Ok(())
}

/// Which channel ids are currently being captured - used by the frontend on
/// startup to sync its own "enabled" checkboxes with whatever devices were
/// automatically resumed from persisted settings (see `settings_store`),
/// since those start capturing before the frontend ever calls
/// `start_capture` itself.
#[tauri::command]
pub fn get_active_channels(state: State<AppState>) -> Vec<String> {
    read_or_recover(&state.active_channels).clone()
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
        CaptureStatus::Ready { .. } | CaptureStatus::Conflict { .. } | CaptureStatus::Failed { .. } => {
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
pub fn set_buffer_duration(app: AppHandle, state: State<AppState>, seconds: u32) -> Result<(), String> {
    if seconds == 0 {
        return Err("buffer duration must be at least 1 second".into());
    }
    *lock_or_recover(&state.buffer_duration_secs) = seconds;
    settings_store::save(&app, &state);
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

/// Clears every active channel's rolling buffer and the cached snapshot
/// used by `export_clip`. Split out from the `flush_buffers` command so the
/// "Reset Buffer" hotkey action (`hotkey::reset_buffer`) can share the same
/// logic without going through Tauri's command-invocation machinery.
pub(crate) fn flush_all_buffers(state: &AppState) {
    for buffer in lock_or_recover(&state.buffers).values() {
        buffer.clear();
    }
    lock_or_recover(&state.last_snapshot).clear();
    println!("[commands] flushed all buffered audio");
}

/// Immediately resets every active channel's rolling buffer back to empty
/// and clears the cached snapshot used by `export_clip`. Called when the set
/// of captured devices changes, so stale audio from the old device
/// selection never gets blended with newly-captured audio.
#[tauri::command]
pub fn flush_buffers(state: State<AppState>) {
    flush_all_buffers(&state);
}

/// Commits whatever capture is currently staged in `AppState.pending_capture`
/// (set by `hotkey::trigger_capture` when a clip was already loaded) into
/// `last_snapshot` - called once the frontend's own themed confirmation
/// modal has been accepted. A no-op if nothing is staged.
#[tauri::command]
pub fn confirm_capture_overwrite(state: State<AppState>) {
    let pending = lock_or_recover(&state.pending_capture).take();
    if let Some(snapshot) = pending {
        commit_snapshot(&state, &snapshot);
    }
}

/// Discards whatever capture is currently staged in `AppState.pending_capture`
/// without committing it - called once the frontend's confirmation modal is
/// declined, leaving the current session untouched.
#[tauri::command]
pub fn discard_pending_capture(state: State<AppState>) {
    *lock_or_recover(&state.pending_capture) = None;
}

/// Terminates the app entirely - closes every window and shuts down the
/// backend cleanly. Backs the top bar menu's "Exit App" option.
#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

/// Returns the accelerator string currently bound to each named hotkey
/// action ("captureSnip"/"showApp"/"resetBuffer") - empty means unbound.
#[tauri::command]
pub fn get_hotkeys(state: State<AppState>) -> std::collections::HashMap<String, String> {
    lock_or_recover(&state.hotkeys).clone()
}

/// Unregisters `action`'s current accelerator (if any) and attempts to
/// register `shortcut` in its place (unless `shortcut` is empty, which just
/// leaves the action unbound). If the new shortcut fails to register (e.g.
/// it's already taken by another application), the previous binding is
/// restored so the action is never left silently broken, and an error is
/// returned so the UI can notify the user.
#[tauri::command]
pub fn update_hotkey(
    app: AppHandle,
    state: State<AppState>,
    action: String,
    shortcut: String,
) -> Result<(), String> {
    let action_id = hotkey::static_action_id(&action)?;
    let global_shortcut = app.global_shortcut();
    let mut hotkeys = lock_or_recover(&state.hotkeys);
    let previous = hotkeys.get(action_id).cloned().unwrap_or_default();

    if !previous.is_empty() {
        if let Err(err) = global_shortcut.unregister(previous.as_str()) {
            eprintln!("[hotkey] failed to unregister previous shortcut '{previous}' for '{action_id}': {err}");
        }
    }

    if !shortcut.is_empty() {
        if let Err(err) = hotkey::register_action_hotkey(&app, action_id, shortcut.as_str()) {
            if !previous.is_empty() {
                if let Err(restore_err) = hotkey::register_action_hotkey(&app, action_id, previous.as_str()) {
                    eprintln!(
                        "[hotkey] failed to restore previous shortcut '{previous}' for '{action_id}': {restore_err}"
                    );
                }
            }
            return Err(format!("failed to register hotkey '{shortcut}': {err}"));
        }
    }

    println!("[hotkey] updated '{action_id}' from '{previous}' to '{shortcut}'");
    hotkeys.insert(action_id.to_string(), shortcut);
    drop(hotkeys); // must release before `save` re-locks the same (non-reentrant) mutex

    settings_store::save(&app, &state);
    Ok(())
}

/// General app-behavior preferences, configured from the Settings modal's
/// "General" tab.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    pub minimize_to_tray: bool,
    pub close_to_tray: bool,
}

#[tauri::command]
pub fn get_general_settings(state: State<AppState>) -> GeneralSettings {
    GeneralSettings {
        minimize_to_tray: *lock_or_recover(&state.minimize_to_tray),
        close_to_tray: *lock_or_recover(&state.close_to_tray),
    }
}

#[tauri::command]
pub fn set_minimize_to_tray(app: AppHandle, state: State<AppState>, enabled: bool) {
    *lock_or_recover(&state.minimize_to_tray) = enabled;
    settings_store::save(&app, &state);
}

#[tauri::command]
pub fn set_close_to_tray(app: AppHandle, state: State<AppState>, enabled: bool) {
    *lock_or_recover(&state.close_to_tray) = enabled;
    settings_store::save(&app, &state);
}

/// Per-device default volume (linear multiplier), applied to a channel's
/// edit params the moment a new snapshot is captured for it.
#[tauri::command]
pub fn get_default_volumes(state: State<AppState>) -> std::collections::HashMap<String, f32> {
    lock_or_recover(&state.default_volumes).clone()
}

#[tauri::command]
pub fn set_default_volume(app: AppHandle, state: State<AppState>, channel_id: String, volume: f32) {
    lock_or_recover(&state.default_volumes).insert(channel_id, volume);
    settings_store::save(&app, &state);
}
