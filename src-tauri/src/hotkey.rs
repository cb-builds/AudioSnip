use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::commands::{lock_or_recover, panic_message, snapshot_active_channels, CaptureStatus};
use crate::state::AppState;

/// Default global hotkey registered at startup; changed at runtime via the
/// `update_hotkey` command.
pub const DEFAULT_HOTKEY: &str = "Ctrl+Shift+K";

/// Registers the default global hotkey at startup.
pub fn register_default_hotkey(app: &AppHandle) -> Result<(), tauri_plugin_global_shortcut::Error> {
    app.global_shortcut()
        .on_shortcut(DEFAULT_HOTKEY, on_hotkey_triggered)
}

/// Handler shared by every shortcut registration (the startup default and
/// any later `update_hotkey` change): takes a non-destructive snapshot of
/// the active channels' rolling buffers, stores the result in
/// `AppState.capture_status`, and brings the main window to front.
///
/// This deliberately does *not* push a `clip-capture-started`/
/// `clip-capture-triggered` event pair anymore - a `tauri-plugin-global-
/// shortcut` callback fires from the OS the instant the accelerator is
/// pressed, with no guarantee the webview has finished (re-)registering its
/// `listen()` calls (e.g. right after a reload). An event emitted in that
/// window is simply dropped - Tauri doesn't buffer or replay it - which
/// showed up as the frontend seeing `clip-capture-started` but never
/// `clip-capture-triggered`, even though this handler completed and logged
/// success. Storing the result in state and letting the frontend poll
/// `get_capture_status` removes that race entirely: every poll is a fresh,
/// self-contained round trip against whatever is actually stored right now.
///
/// This also runs outside Tauri's normal async command machinery - if
/// `snapshot_active_channels` were to panic here, unwinding across that
/// native callback boundary is undefined behavior and can manifest as an
/// indefinite hang. `catch_unwind` guarantees a status is always stored -
/// `Failed` in the worst case - so the frontend's poll loop always gets a
/// terminal answer instead of polling forever.
pub fn on_hotkey_triggered(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state != ShortcutState::Pressed {
        return;
    }

    println!("[hotkey] hotkey pressed - beginning capture");
    let state = app.state::<AppState>();

    println!("[hotkey] setting capture_status = Processing");
    *lock_or_recover(&state.capture_status) = CaptureStatus::Processing;

    println!("[hotkey] calling snapshot_active_channels...");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        snapshot_active_channels(state.inner())
    }));

    let status = match result {
        Ok(snapshot) => {
            println!(
                "[hotkey] clip capture triggered: {} channel(s) captured",
                snapshot.len()
            );
            CaptureStatus::Ready { snapshot }
        }
        Err(panic_payload) => {
            let message = panic_message(&panic_payload);
            eprintln!("[hotkey] snapshot_active_channels panicked: {message}");
            CaptureStatus::Failed { message }
        }
    };

    println!("[hotkey] storing final capture_status for the frontend to poll");
    *lock_or_recover(&state.capture_status) = status;
    println!("[hotkey] capture complete");

    if let Some(window) = app.get_webview_window("main") {
        if let Err(err) = window.show() {
            eprintln!("[hotkey] failed to show main window: {err}");
        }
        if let Err(err) = window.set_focus() {
            eprintln!("[hotkey] failed to focus main window: {err}");
        }
    }
}
