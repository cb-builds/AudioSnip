mod apps;
mod audio;
mod commands;
mod hotkey;
mod settings_store;
mod state;
mod tray;

use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;

use commands::lock_or_recover;

/// Passed to the app's own executable by the OS-level autostart entry (see
/// the `tauri_plugin_autostart::Builder` below) - always present on an
/// autostart-triggered launch, regardless of the user's "Start minimized"
/// preference, since the `auto-launch` crate bakes its argument list in once
/// at plugin setup and can't be changed per-toggle afterward. Whether the
/// window actually stays hidden is decided in `run()`'s `setup` by combining
/// this flag's presence with the persisted `start_minimized` preference.
pub(crate) const MINIMIZED_LAUNCH_ARG: &str = "--minimized";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first - a second launch is intercepted before
        // any other plugin/setup code runs in that second process, which
        // then exits immediately; this closure runs in the *original*
        // (already-running) instance instead, bringing its window forward
        // so launching the app again feels like "focus AudioSnip," not
        // "open a second copy."
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            hotkey::show_and_focus_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("AudioSnip")
                .arg(MINIMIZED_LAUNCH_ARG)
                .build(),
        )
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
            commands::reset_settings_to_default,
            commands::get_general_settings,
            commands::set_minimize_to_tray,
            commands::set_close_to_tray,
            commands::set_run_at_startup,
            commands::set_start_minimized,
            commands::get_default_volumes,
            commands::set_default_volume,
            hotkey::request_capture,
            apps::get_active_applications,
            apps::get_installed_applications,
            apps::get_exe_metadata,
            apps::add_application_source,
            apps::remove_application_source,
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
                *lock_or_recover(&state.run_at_startup) = persisted.run_at_startup;
                *lock_or_recover(&state.start_minimized) = persisted.start_minimized;
                *lock_or_recover(&state.application_sources) = persisted.application_sources.clone();
            }

            // Self-heal the OS-level autostart registration to match the
            // persisted preference every launch - the frontend also flips
            // this directly when the checkbox changes, but re-applying it
            // here catches drift (e.g. the user manually removed the entry,
            // or a bundle update changed the registered exe path) and
            // ensures the very first-ever launch (default: on) actually
            // registers, not just shows the checkbox pre-checked.
            if let Err(err) = if persisted.run_at_startup {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            } {
                eprintln!("[autostart] failed to sync autostart registration: {err}");
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

            // The main window is created hidden (`"visible": false` in
            // `tauri.conf.json`) so a `--minimized` autostart launch never
            // flashes it on screen before this check runs. Every other
            // launch path (manual double-click, an autostart launch with
            // "Start minimized" turned off) explicitly shows and focuses it
            // here instead.
            let launched_minimized = std::env::args().any(|arg| arg == MINIMIZED_LAUNCH_ARG);
            let should_start_hidden =
                launched_minimized && *lock_or_recover(&handle.state::<state::AppState>().start_minimized);
            if !should_start_hidden {
                hotkey::show_and_focus_main_window(app.handle());
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
