mod commands;
mod config;
mod daemon;
mod tray;

use std::time::Duration;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
#[cfg(desktop)]
use tauri_plugin_deep_link::DeepLinkExt;

use daemon::DaemonManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // ---- Plugins ----
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        // ---- Managed state ----
        .manage(DaemonManager::new())
        .manage(commands::AuthState::new())
        // ---- IPC commands ----
        .invoke_handler(tauri::generate_handler![
            commands::get_daemon_status,
            commands::start_agent,
            commands::stop_agent,
            commands::pause_agent,
            commands::resume_agent,
            commands::get_config,
            commands::save_config,
            commands::has_config,
            commands::configure_agent,
            commands::get_log_content,
            commands::open_downloads_dir,
            commands::sign_in,
            commands::start_browser_auth,
            commands::check_auth_result,
        ])
        // ---- App setup ----
        .setup(|app| {
            let handle = app.handle().clone();

            // --- Detect first-launch vs returning user ---
            if config::config_exists() {
                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.hide();
                }
            } else {
                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.show();
                    let _ = main_window.set_focus();
                }
            }

            // --- Deep link handler (djtoolkit://auth/callback) ---
            #[cfg(desktop)]
            {
                let dl_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let auth = dl_handle.state::<commands::AuthState>();
                    for url in event.urls() {
                        commands::handle_auth_callback(url.as_str(), &*auth);
                    }
                    // Bring the app window to focus
                    if let Some(w) = dl_handle.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                });
            }

            // --- System tray ---
            tray::setup_tray(app.handle())
                .map_err(|e| format!("Failed to setup tray: {e}"))?;

            // --- On startup, detect if daemon is already running ---
            {
                let manager = handle.state::<DaemonManager>();
                daemon::check_daemon_health(&manager);
                tray::refresh_menu(&handle);
            }

            // --- Health-check polling (every 10 seconds) ---
            let health_handle = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(10));
                let manager = health_handle.state::<DaemonManager>();
                let prev = {
                    let s = manager.state.lock().unwrap_or_else(|e| e.into_inner());
                    s.clone()
                };
                daemon::check_daemon_health(&manager);
                let curr = {
                    let s = manager.state.lock().unwrap_or_else(|e| e.into_inner());
                    s.clone()
                };
                if prev != curr {
                    tray::refresh_menu(&health_handle);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
