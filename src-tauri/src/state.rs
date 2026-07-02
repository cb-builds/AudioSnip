use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use crate::audio::capture::wasapi::WasapiCaptureBackend;
use crate::audio::capture::{CaptureBackend, StreamFormat};
use crate::audio::ring_buffer::RollingBuffer;
use crate::commands::CaptureStatus;
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
    /// The accelerator string of the currently registered global hotkey, so
    /// `update_hotkey` knows what to unregister before binding a new one.
    pub current_hotkey: Mutex<String>,
    /// Rolling-buffer duration (seconds) applied to newly-started captures.
    /// Changing this does not resize buffers already in use.
    pub buffer_duration_secs: Mutex<u32>,
    /// The global hotkey's capture lifecycle - set by `hotkey::on_hotkey_triggered`
    /// and polled by the frontend via the `get_capture_status` command
    /// instead of a push event (see `CaptureStatus`'s docs for why).
    pub capture_status: Mutex<CaptureStatus>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            active_channels: RwLock::new(Vec::new()),
            capture: Mutex::new(Box::new(WasapiCaptureBackend::default())),
            buffers: Mutex::new(HashMap::new()),
            formats: Mutex::new(HashMap::new()),
            last_snapshot: Mutex::new(HashMap::new()),
            current_hotkey: Mutex::new(hotkey::DEFAULT_HOTKEY.to_string()),
            buffer_duration_secs: Mutex::new(DEFAULT_BUFFER_DURATION_SECS),
            capture_status: Mutex::new(CaptureStatus::Idle),
        }
    }
}
