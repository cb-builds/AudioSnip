mod audio;
mod commands;
mod hotkey;
mod state;
mod tray;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_channels,
            commands::start_capture,
            commands::stop_capture,
            commands::capture_snapshot,
            commands::get_capture_status,
            commands::export_clip,
            commands::get_hotkey,
            commands::update_hotkey,
            commands::get_buffer_duration,
            commands::set_buffer_duration,
            commands::flush_buffers,
        ])
        .setup(|app| {
            tray::setup(app.handle())?;
            hotkey::register_default_hotkey(app.handle())?;

            if let Some(window) = app.get_webview_window("main") {
                let window_to_hide = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_to_hide.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
