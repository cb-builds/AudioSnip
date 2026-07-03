use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use crate::audio::capture::wasapi::WasapiCaptureBackend;
use crate::audio::capture::{CaptureBackend, StreamFormat};
use crate::audio::ring_buffer::RollingBuffer;
use crate::commands::{CaptureStatus, TrackSnapshot};
use crate::hotkey;

/// Default rolling-buffer duration, in seconds, used until the user changes
/// it via the Settings panel.
pub const DEFAULT_BUFFER_DURATION_SECS: u32 = 30;

/// Control-plane app state. The realtime `cpal` audio callback only ever
/// touches the lock-free rolling buffer handed to it in
/// `CaptureBackend::start_capture` - everything here is guarded by ordinary
/// locks because it's only ever accessed from command-handler threads, never
/// from inside the audio callback itself.
pub struct AppState {
    /// IDs of channels currently being captured.
    pub active_channels: RwLock<Vec<String>>,
    /// The capture backend, boxed behind the `CaptureBackend` trait so a
    /// future Linux backend can be swapped in without touching this state.
    pub capture: Mutex<Box<dyn CaptureBackend + Send>>,
    /// Each active channel's rolling circular buffer. Shared (via `Arc`)
    /// with the audio callback that writes into it; readers here only ever
    /// take non-destructive snapshots.
    pub buffers: Mutex<HashMap<String, Arc<RollingBuffer>>>,
    /// Negotiated sample rate/channel count per active channel, needed to
    /// interpret trim/fade timings and resample before mixdown.
    pub formats: Mutex<HashMap<String, StreamFormat>>,
    /// Raw samples from the most recent snapshot per channel, cached so
    /// `export_clip` can reuse exactly what the user saw/edited rather than
    /// whatever the live rolling buffer has moved on to by export time.
    pub last_snapshot: Mutex<HashMap<String, Vec<f32>>>,
    /// Accelerator string currently bound to each named hotkey action
    /// (`hotkey::ACTION_CAPTURE_SNIP`/`ACTION_SHOW_APP`/`ACTION_RESET_BUFFER`)
    /// - empty means "unbound". Lets `update_hotkey` know what to unregister
    /// before binding a new one for that action.
    pub hotkeys: Mutex<HashMap<String, String>>,
    /// Rolling-buffer duration (seconds) applied to newly-started captures.
    /// Changing this does not resize buffers already in use.
    pub buffer_duration_secs: Mutex<u32>,
    /// The global hotkey's capture lifecycle - set by `hotkey::trigger_capture`
    /// and polled by the frontend via the `get_capture_status` command
    /// instead of a push event (see `CaptureStatus`'s docs for why).
    pub capture_status: Mutex<CaptureStatus>,
    /// A freshly captured clip that's held here (not yet committed to
    /// `last_snapshot`) while the frontend's own themed confirmation modal
    /// asks the user whether it should overwrite the clip already loaded -
    /// see `commands::confirm_capture_overwrite`/`discard_pending_capture`.
    pub pending_capture: Mutex<Option<Vec<TrackSnapshot>>>,
    /// Whether minimizing the main window hides it to the tray instead of
    /// the taskbar.
    pub minimize_to_tray: Mutex<bool>,
    /// Whether closing the main window hides it to the tray instead of
    /// quitting the app.
    pub close_to_tray: Mutex<bool>,
    /// Per-device default volume (linear multiplier), applied to a channel's
    /// edit params the moment a new snapshot is captured for it. Absent
    /// entries default to unity gain (1.0) on the frontend.
    pub default_volumes: Mutex<HashMap<String, f32>>,
    /// Whether the app should register itself to launch when the OS starts.
    /// The frontend flips the actual OS-level registration itself (via the
    /// autostart plugin's `enable`/`disable`) - this mirrors that decision so
    /// it can be persisted and self-healed (re-applied) on the next launch.
    pub run_at_startup: Mutex<bool>,
    /// Whether an autostart-triggered launch should keep the main window
    /// hidden in the tray rather than showing it - only takes effect when
    /// the process was actually started with the `--minimized` argument
    /// (see `lib::MINIMIZED_LAUNCH_ARG`), since the autostart entry always
    /// passes that flag regardless of this setting (the underlying
    /// `auto-launch` crate bakes its argument list in once at plugin
    /// startup, before any user preference can be read) - this flag is what
    /// actually decides whether the window stays hidden.
    pub start_minimized: Mutex<bool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            active_channels: RwLock::new(Vec::new()),
            capture: Mutex::new(Box::new(WasapiCaptureBackend::default())),
            buffers: Mutex::new(HashMap::new()),
            formats: Mutex::new(HashMap::new()),
            last_snapshot: Mutex::new(HashMap::new()),
            hotkeys: Mutex::new(hotkey::default_hotkeys()),
            buffer_duration_secs: Mutex::new(DEFAULT_BUFFER_DURATION_SECS),
            capture_status: Mutex::new(CaptureStatus::Idle),
            pending_capture: Mutex::new(None),
            minimize_to_tray: Mutex::new(true),
            close_to_tray: Mutex::new(true),
            default_volumes: Mutex::new(HashMap::new()),
            run_at_startup: Mutex::new(true),
            start_minimized: Mutex::new(true),
        }
    }
}
