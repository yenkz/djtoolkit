mod commands;
mod config;
mod daemon;
mod tray;

use std::time::Duration;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

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
        // ---- Managed state ----
        .manage(DaemonManager::new())
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
