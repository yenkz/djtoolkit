use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

use crate::daemon::{self, DaemonManager, DaemonState};

/// Build the system tray icon and attach the context menu.
pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let manager = app.state::<DaemonManager>();
    let state = manager.state.lock().unwrap_or_else(|e| e.into_inner());
    let menu = build_menu(app, &state)?;
    drop(state);

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .build(app)?;

    Ok(())
}

/// Build the context menu reflecting the current daemon state.
fn build_menu(
    app: &AppHandle,
    state: &DaemonState,
) -> Result<Menu<Wry>, Box<dyn std::error::Error>> {
    let menu = Menu::new(app)?;

    // Title (disabled label).
    let title = MenuItem::with_id(app, "title", "djtoolkit", false, None::<&str>)?;
    menu.append(&title)?;

    // Status line.
    let status_text = match state {
        DaemonState::Running => "\u{25CF} Running",
        DaemonState::Paused => "\u{25CF} Paused",
        DaemonState::Starting => "\u{25CF} Starting...",
        DaemonState::Stopped => "\u{25CB} Stopped",
    };
    let status = MenuItem::with_id(app, "status", status_text, false, None::<&str>)?;
    menu.append(&status)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    // Start / Pause+Stop — shown contextually.
    let is_running = *state == DaemonState::Running;
    let is_paused = *state == DaemonState::Paused;
    let is_stopped = *state == DaemonState::Stopped;

    if is_stopped {
        let start = MenuItem::with_id(app, "start", "Start", true, None::<&str>)?;
        menu.append(&start)?;
    }
    if is_running {
        let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
        menu.append(&pause)?;
    }
    if is_paused {
        let resume = MenuItem::with_id(app, "resume", "Resume", true, None::<&str>)?;
        menu.append(&resume)?;
    }
    if is_running || is_paused {
        let stop = MenuItem::with_id(app, "stop", "Stop", true, None::<&str>)?;
        menu.append(&stop)?;
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    // Launch at Startup (checkbox).
    let launch_at_startup = {
        let cfg = crate::config::load_config().unwrap_or_default();
        cfg.launch_at_startup
    };
    let startup =
        CheckMenuItem::with_id(app, "startup", "Launch at Startup", true, launch_at_startup, None::<&str>)?;
    menu.append(&startup)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    // Utility items.
    let logs = MenuItem::with_id(app, "logs", "View Logs", true, None::<&str>)?;
    menu.append(&logs)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    menu.append(&settings)?;
    let dashboard = MenuItem::with_id(app, "dashboard", "Web Dashboard", true, None::<&str>)?;
    menu.append(&dashboard)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    menu.append(&quit)?;

    Ok(menu)
}

/// Handle a click on any context menu item.
fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "start" => {
            let manager = app.state::<DaemonManager>();
            if let Err(e) = daemon::start_daemon(app, &manager) {
                eprintln!("Failed to start daemon: {e}");
            }
            refresh_menu(app);
        }
        "pause" => {
            let manager = app.state::<DaemonManager>();
            if let Err(e) = daemon::pause_daemon(&manager) {
                eprintln!("Failed to pause daemon: {e}");
            }
            refresh_menu(app);
        }
        "resume" => {
            let manager = app.state::<DaemonManager>();
            if let Err(e) = daemon::resume_daemon(&manager) {
                eprintln!("Failed to resume daemon: {e}");
            }
            refresh_menu(app);
        }
        "stop" => {
            let manager = app.state::<DaemonManager>();
            if let Err(e) = daemon::stop_daemon(&manager) {
                eprintln!("Failed to stop daemon: {e}");
            }
            refresh_menu(app);
        }
        "startup" => {
            // Toggle the launch-at-startup setting.
            if let Ok(mut cfg) = crate::config::load_config() {
                cfg.launch_at_startup = !cfg.launch_at_startup;
                let _ = crate::config::save_config(&cfg);
            }
            // No menu refresh needed — the checkbox toggles visually on its own.
        }
        "logs" => {
            open_or_create_window(app, "logs", "djtoolkit - Logs", 700.0, 450.0);
        }
        "settings" => {
            open_or_create_window(app, "settings", "djtoolkit - Settings", 500.0, 500.0);
        }
        "dashboard" => {
            let _ = open::that("https://www.djtoolkit.net");
        }
        "quit" => {
            // Quit the Tauri app but do NOT stop the daemon.
            app.exit(0);
        }
        _ => {}
    }
}

/// Rebuild the tray menu to reflect the current daemon state.
pub fn refresh_menu(app: &AppHandle) {
    let manager = app.state::<DaemonManager>();
    let state = manager.state.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(menu) = build_menu(app, &state) {
        if let Some(tray) = app.tray_by_id("main-tray") {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// Open an existing window by label, or create a new one if it doesn't exist yet.
fn open_or_create_window(app: &AppHandle, label: &str, title: &str, width: f64, height: f64) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        // Window defined in tauri.conf.json but not yet instantiated —
        // create it dynamically.
        let url = tauri::WebviewUrl::App(format!("/{label}").into());
        let _ = tauri::WebviewWindowBuilder::new(app, label, url)
            .title(title)
            .inner_size(width, height)
            .center()
            .build();
    }
}
