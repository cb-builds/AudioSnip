use std::collections::HashMap;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::commands::{self, lock_or_recover, panic_message, CaptureStatus};
use crate::state::AppState;

/// Default accelerator registered at startup for the "Capture Snip" action;
/// changed at runtime via the `update_hotkey` command.
pub const DEFAULT_HOTKEY: &str = "Ctrl+Shift+K";

pub const ACTION_CAPTURE_SNIP: &str = "captureSnip";
pub const ACTION_SHOW_APP: &str = "showApp";
pub const ACTION_RESET_BUFFER: &str = "resetBuffer";

/// The 3 named hotkey slots and their startup bindings - only "Capture
/// Snip" has one by default; "Show App" and "Reset Buffer" start unbound
/// (blank), matching the Settings UI's stated defaults.
pub fn default_hotkeys() -> HashMap<String, String> {
    HashMap::from([
        (ACTION_CAPTURE_SNIP.to_string(), DEFAULT_HOTKEY.to_string()),
        (ACTION_SHOW_APP.to_string(), String::new()),
        (ACTION_RESET_BUFFER.to_string(), String::new()),
    ])
}

/// Maps a frontend-supplied action id to the `&'static str` constant of the
/// same value, so it can be moved into a `'static` shortcut callback
/// closure - the frontend can only ever send one of the 3 known actions.
pub fn static_action_id(action: &str) -> Result<&'static str, String> {
    match action {
        ACTION_CAPTURE_SNIP => Ok(ACTION_CAPTURE_SNIP),
        ACTION_SHOW_APP => Ok(ACTION_SHOW_APP),
        ACTION_RESET_BUFFER => Ok(ACTION_RESET_BUFFER),
        other => Err(format!("unknown hotkey action '{other}'")),
    }
}

/// Registers `accelerator` to run `action_id`'s behavior when pressed.
pub fn register_action_hotkey(
    app: &AppHandle,
    action_id: &'static str,
    accelerator: &str,
) -> Result<(), tauri_plugin_global_shortcut::Error> {
    app.global_shortcut()
        .on_shortcut(accelerator, move |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            run_action(app, action_id);
        })
}

fn run_action(app: &AppHandle, action_id: &str) {
    match action_id {
        ACTION_CAPTURE_SNIP => trigger_capture(app),
        ACTION_SHOW_APP => show_and_focus_main_window(app),
        ACTION_RESET_BUFFER => reset_buffer(app),
        _ => {}
    }
}

/// Un-minimizes, shows, and focuses the main window, in that order - shared
/// by the "Show App" hotkey, the tray's "Show App" menu item, the tray
/// icon's left-click, and `trigger_capture`'s tail. `show()` alone doesn't
/// restore a minimized window on Windows, so `unminimize()` has to run first
/// for the window to actually reach the foreground.
pub fn show_and_focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(err) = window.unminimize() {
            eprintln!("[hotkey] failed to unminimize main window: {err}");
        }
        if let Err(err) = window.show() {
            eprintln!("[hotkey] failed to show main window: {err}");
        }
        if let Err(err) = window.set_focus() {
            eprintln!("[hotkey] failed to focus main window: {err}");
        }
    }
}

/// Clears every active channel's rolling buffer - shared by the "Reset
/// Buffer" hotkey and the `flush_buffers` command.
fn reset_buffer(app: &AppHandle) {
    let state = app.state::<AppState>();
    commands::flush_all_buffers(&state);
    println!("[hotkey] reset_buffer action: buffers flushed");
}

/// Takes a non-destructive snapshot of the active channels' rolling
/// buffers, stores the result in `AppState.capture_status`, and brings the
/// main window to front. Shared by the "Capture Snip" hotkey, the tray's
/// "Snip" menu item, and the top bar's "Capture Snip" button (via the
/// `request_capture` command) - all three just need "run a capture," with no
/// caller-specific context.
///
/// If a clip is already loaded (`AppState.last_snapshot` is non-empty), the
/// newly captured audio is staged in `AppState.pending_capture` and reported
/// via `CaptureStatus::Conflict` instead of `Ready` - the frontend is
/// responsible for showing its own themed confirmation modal and calling
/// `confirm_capture_overwrite`/`discard_pending_capture` based on the
/// answer. This deliberately never shows a native OS dialog here (that would
/// play the OS's system notification sound); this applies identically no
/// matter which of the three entry points triggered the capture, since they
/// all funnel through this one function.
///
/// This deliberately does *not* push a `clip-capture-started`/
/// `clip-capture-triggered` event pair - a `tauri-plugin-global-shortcut`
/// callback fires from the OS the instant the accelerator is pressed, with
/// no guarantee the webview has finished (re-)registering its `listen()`
/// calls (e.g. right after a reload). An event emitted in that window is
/// simply dropped - Tauri doesn't buffer or replay it - which showed up as
/// the frontend seeing `clip-capture-started` but never
/// `clip-capture-triggered`, even though this handler completed and logged
/// success. Storing the result in state and letting the frontend poll
/// `get_capture_status` removes that race entirely: every poll is a fresh,
/// self-contained round trip against whatever is actually stored right now.
///
/// This also runs outside Tauri's normal async command machinery when
/// invoked from the global-shortcut callback - if `snapshot_active_channels`
/// were to panic there, unwinding across that native callback boundary is
/// undefined behavior and can manifest as an indefinite hang. `catch_unwind`
/// guarantees a status is always stored - `Failed` in the worst case - so
/// the frontend's poll loop always gets a terminal answer instead of polling
/// forever.
///
/// Deliberately does *not* set `capture_status = Processing` for a conflict:
/// the frontend's own modal can take arbitrarily long to answer, and the
/// poll-timeout logic counts consecutive `Processing` polls, not elapsed
/// wall-clock time - leaving `Processing` set for the whole wait would
/// eventually trip that timeout even though nothing has actually failed.
pub fn trigger_capture(app: &AppHandle) {
    println!("[hotkey] capture triggered - beginning capture");
    let state = app.state::<AppState>();

    let already_has_clip = !lock_or_recover(&state.last_snapshot).is_empty();

    if !already_has_clip {
        println!("[hotkey] setting capture_status = Processing");
        *lock_or_recover(&state.capture_status) = CaptureStatus::Processing;
    }

    println!("[hotkey] calling snapshot_active_channels_uncached...");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        commands::snapshot_active_channels_uncached(state.inner())
    }));

    let snapshot = match result {
        Ok(snapshot) => snapshot,
        Err(panic_payload) => {
            let message = panic_message(&panic_payload);
            eprintln!("[hotkey] snapshot_active_channels_uncached panicked: {message}");
            *lock_or_recover(&state.capture_status) = CaptureStatus::Failed { message };
            show_and_focus_main_window(app);
            return;
        }
    };

    show_and_focus_main_window(app);

    if !already_has_clip {
        println!(
            "[hotkey] clip capture triggered: {} channel(s) captured",
            snapshot.len()
        );
        commands::commit_snapshot(state.inner(), &snapshot);
        *lock_or_recover(&state.capture_status) = CaptureStatus::Ready { snapshot };
        println!("[hotkey] capture complete");
        return;
    }

    println!(
        "[hotkey] a clip is already loaded - staging the new capture and reporting Conflict for the frontend's own confirmation modal"
    );
    *lock_or_recover(&state.pending_capture) = Some(snapshot.clone());
    *lock_or_recover(&state.capture_status) = CaptureStatus::Conflict { snapshot };
}

/// Thin command wrapper so the top bar's "Capture Snip" button can trigger
/// exactly the same capture (and overwrite-confirmation) flow as the global
/// hotkey and the tray's "Snip" menu item.
#[tauri::command]
pub fn request_capture(app: AppHandle) {
    trigger_capture(&app);
}
