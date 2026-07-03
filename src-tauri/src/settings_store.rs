use std::collections::HashMap;
use std::fs;

use tauri::{AppHandle, Manager};

use crate::commands::{lock_or_recover, read_or_recover};
use crate::hotkey;
use crate::state::{AppState, DEFAULT_BUFFER_DURATION_SECS};

const SETTINGS_FILE_NAME: &str = "settings.json";

fn default_true() -> bool {
    true
}

fn default_buffer_duration_secs() -> u32 {
    DEFAULT_BUFFER_DURATION_SECS
}

/// Every user preference persisted to disk - hotkey bindings, which devices
/// were toggled on, per-device default volumes, the tray behavior toggles,
/// the buffer duration, and the startup preferences - so they reload
/// automatically the next time the app starts instead of resetting to
/// defaults every session. Stored as `settings.json` inside the OS's
/// standard per-app data directory (e.g. `%APPDATA%/com.audiosnip.app` on
/// Windows), resolved via Tauri's own `app_data_dir()` rather than a
/// hand-picked path.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSettings {
    #[serde(default = "hotkey::default_hotkeys")]
    pub hotkeys: HashMap<String, String>,
    #[serde(default)]
    pub active_channel_ids: Vec<String>,
    #[serde(default)]
    pub default_volumes: HashMap<String, f32>,
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    #[serde(default = "default_buffer_duration_secs")]
    pub buffer_duration_secs: u32,
    #[serde(default = "default_true")]
    pub run_at_startup: bool,
    #[serde(default = "default_true")]
    pub start_minimized: bool,
}

impl Default for PersistedSettings {
    fn default() -> Self {
        Self {
            hotkeys: hotkey::default_hotkeys(),
            active_channel_ids: Vec::new(),
            default_volumes: HashMap::new(),
            minimize_to_tray: true,
            close_to_tray: true,
            buffer_duration_secs: DEFAULT_BUFFER_DURATION_SECS,
            run_at_startup: true,
            start_minimized: true,
        }
    }
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    match app.path().app_data_dir() {
        Ok(dir) => Some(dir.join(SETTINGS_FILE_NAME)),
        Err(err) => {
            eprintln!("[settings] failed to resolve the app data directory: {err}");
            None
        }
    }
}

/// Reads `settings.json` from the OS app-data directory, falling back to
/// defaults if the file is missing (expected on first run) or malformed.
pub fn load(app: &AppHandle) -> PersistedSettings {
    let Some(path) = settings_path(app) else {
        return PersistedSettings::default();
    };

    match fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|err| {
            eprintln!(
                "[settings] failed to parse '{}': {err} - falling back to defaults",
                path.display()
            );
            PersistedSettings::default()
        }),
        Err(_) => {
            println!("[settings] no settings file at '{}' yet - using defaults", path.display());
            PersistedSettings::default()
        }
    }
}

/// Snapshots the persisted slice of `AppState` and writes it to
/// `settings.json`, creating the app-data directory if it doesn't exist yet.
/// Called after every settings-mutating command so preferences survive a
/// restart without the caller having to remember to do it.
pub fn save(app: &AppHandle, state: &AppState) {
    let Some(path) = settings_path(app) else { return };

    let settings = PersistedSettings {
        hotkeys: lock_or_recover(&state.hotkeys).clone(),
        active_channel_ids: read_or_recover(&state.active_channels).clone(),
        default_volumes: lock_or_recover(&state.default_volumes).clone(),
        minimize_to_tray: *lock_or_recover(&state.minimize_to_tray),
        close_to_tray: *lock_or_recover(&state.close_to_tray),
        buffer_duration_secs: *lock_or_recover(&state.buffer_duration_secs),
        run_at_startup: *lock_or_recover(&state.run_at_startup),
        start_minimized: *lock_or_recover(&state.start_minimized),
    };

    if let Some(parent) = path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            eprintln!("[settings] failed to create app data directory '{}': {err}", parent.display());
            return;
        }
    }

    match serde_json::to_string_pretty(&settings) {
        Ok(json) => {
            if let Err(err) = fs::write(&path, json) {
                eprintln!("[settings] failed to write '{}': {err}", path.display());
            }
        }
        Err(err) => eprintln!("[settings] failed to serialize settings: {err}"),
    }
}
