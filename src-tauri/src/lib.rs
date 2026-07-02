mod audio;
mod commands;
mod hotkey;
mod settings_store;
mod state;
mod tray;

use tauri::Manager;

use commands::lock_or_recover;

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
            commands::get_active_channels,
            commands::capture_snapshot,
            commands::get_capture_status,
            commands::export_clip,
            commands::get_hotkeys,
            commands::update_hotkey,
            commands::get_buffer_duration,
            commands::set_buffer_duration,
            commands::flush_buffers,
            commands::confirm_capture_overwrite,
            commands::discard_pending_capture,
            commands::exit_app,
            commands::get_general_settings,
            commands::set_minimize_to_tray,
            commands::set_close_to_tray,
            commands::get_default_volumes,
            commands::set_default_volume,
            hotkey::request_capture,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let persisted = settings_store::load(&handle);

            {
                let state = handle.state::<state::AppState>();
                *lock_or_recover(&state.hotkeys) = persisted.hotkeys.clone();
                *lock_or_recover(&state.default_volumes) = persisted.default_volumes.clone();
                *lock_or_recover(&state.minimize_to_tray) = persisted.minimize_to_tray;
                *lock_or_recover(&state.close_to_tray) = persisted.close_to_tray;
                *lock_or_recover(&state.buffer_duration_secs) = persisted.buffer_duration_secs;
            }

            tray::setup(app.handle())?;

            // Register whichever accelerator is actually bound to each
            // action (rather than always the hard-coded default), so a
            // custom binding from a previous session survives a restart.
            for (action_id, accelerator) in persisted.hotkeys.iter() {
                if accelerator.is_empty() {
                    continue;
                }
                match hotkey::static_action_id(action_id) {
                    Ok(action_id) => {
                        if let Err(err) = hotkey::register_action_hotkey(app.handle(), action_id, accelerator) {
                            eprintln!(
                                "[hotkey] failed to register persisted hotkey '{accelerator}' for '{action_id}': {err}"
                            );
                        }
                    }
                    Err(err) => eprintln!("[hotkey] skipping unknown persisted action '{action_id}': {err}"),
                }
            }

            // Resume capturing whichever devices were active when the app
            // last closed, so the device selection also survives a restart.
            for channel_id in persisted.active_channel_ids {
                let state = handle.state::<state::AppState>();
                if let Err(err) = commands::start_capture(handle.clone(), state, channel_id.clone()) {
                    eprintln!("[settings] failed to resume capture for '{channel_id}': {err}");
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    let state = app_handle.state::<state::AppState>();
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            if *lock_or_recover(&state.close_to_tray) {
                                api.prevent_close();
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    let _ = window.hide();
                                }
                            }
                        }
                        // Tauri/tao don't expose a dedicated "minimized" window
                        // event - minimizing still fires a `Resized` event on
                        // Windows, so checking `is_minimized()` there is the
                        // standard workaround for intercepting it.
                        tauri::WindowEvent::Resized(_) => {
                            if *lock_or_recover(&state.minimize_to_tray) {
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    if window.is_minimized().unwrap_or(false) {
                                        let _ = window.hide();
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
