use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::hotkey;

/// Sets up the system tray icon - reusing the app's already-configured icon
/// from `tauri.conf.json` (`src-tauri/icons/`), so there's no separate
/// asset to keep in sync - along with:
/// - A left-click / single-click on the icon itself: shows and focuses the
///   main window (the same action as the "Show App" menu item below).
/// - A right-click context menu:
///   - "Snip": runs the same capture as the global hotkey.
///   - "Show App": shows and focuses the main window - named to match the
///     "Show App" hotkey action in Settings, since both do the same thing.
///   - "Exit": quits the app.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let snip = MenuItem::with_id(app, "snip", "Snip", true, None::<&str>)?;
    let show_app = MenuItem::with_id(app, "show_app", "Show App", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&snip, &show_app, &exit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("default window icon should be configured in tauri.conf.json");

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("AudioSnip")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                hotkey::show_and_focus_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "snip" => hotkey::trigger_capture(app),
            "show_app" => hotkey::show_and_focus_main_window(app),
            "exit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}
