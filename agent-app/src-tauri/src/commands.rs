use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

use tauri::State;

use crate::config::{self, AppConfig};
use crate::daemon::{self, DaemonManager};

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_daemon_status(manager: State<'_, DaemonManager>) -> String {
    let state = manager.state.lock().unwrap_or_else(|e| e.into_inner());
    state.as_str().to_string()
}

#[tauri::command]
pub fn start_agent(
    app: tauri::AppHandle,
    manager: State<'_, DaemonManager>,
) -> Result<(), String> {
    daemon::start_daemon(&app, &manager)
}

#[tauri::command]
pub fn stop_agent(manager: State<'_, DaemonManager>) -> Result<(), String> {
    daemon::stop_daemon(&manager)
}

#[tauri::command]
pub fn pause_agent(manager: State<'_, DaemonManager>) -> Result<(), String> {
    daemon::pause_daemon(&manager)
}

#[tauri::command]
pub fn resume_agent(manager: State<'_, DaemonManager>) -> Result<(), String> {
    daemon::resume_daemon(&manager)
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_config() -> Result<AppConfig, String> {
    config::load_config()
}

#[tauri::command]
pub fn save_config(config: AppConfig) -> Result<(), String> {
    config::save_config(&config)
}

#[tauri::command]
pub fn has_config() -> bool {
    config::config_exists()
}

// ---------------------------------------------------------------------------
// Agent headless configuration (setup wizard)
// ---------------------------------------------------------------------------

/// Run `djtoolkit agent configure-headless` with a JSON payload on stdin.
/// This sets up the agent's credentials and connection details.
#[tauri::command]
pub fn configure_agent(
    api_key: String,
    slsk_user: String,
    slsk_pass: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let sidecar = daemon::get_sidecar_path(&app)?;

    let payload = serde_json::json!({
        "api_key": api_key,
        "slsk_user": slsk_user,
        "slsk_pass": slsk_pass,
    });

    let mut child = Command::new(&sidecar)
        .args(["agent", "configure-headless"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn configure command: {e}"))?;

    // Write JSON to stdin and close it.
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin
            .write_all(payload.to_string().as_bytes())
            .map_err(|e| format!("Failed to write to stdin: {e}"))?;
        // stdin is closed when dropped
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for configure command: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Configure command failed: {stderr}"));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Log viewer
// ---------------------------------------------------------------------------

/// Read the last N lines from `agent.log` in the config directory.
#[tauri::command]
pub fn get_log_content(lines: Option<usize>) -> Result<String, String> {
    let log_path = daemon::get_config_dir().join("agent.log");
    if !log_path.exists() {
        return Ok(String::new());
    }

    let max_lines = lines.unwrap_or(200);

    let file = fs::File::open(&log_path).map_err(|e| format!("Failed to open log file: {e}"))?;
    let reader = BufReader::new(file);
    let all_lines: Vec<String> = reader
        .lines()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read log file: {e}"))?;

    // Take the last N lines.
    let start = if all_lines.len() > max_lines {
        all_lines.len() - max_lines
    } else {
        0
    };

    Ok(all_lines[start..].join("\n"))
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/// Open the downloads directory in the system file manager.
#[tauri::command]
pub fn open_downloads_dir() -> Result<(), String> {
    let cfg = config::load_config()?;
    let dir = std::path::PathBuf::from(&cfg.downloads_dir);

    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create downloads dir: {e}"))?;
    }

    open_in_file_manager(&dir)
}

#[cfg(target_os = "macos")]
fn open_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    Command::new("open")
        .arg(path)
        .spawn()
        .map_err(|e| format!("Failed to open Finder: {e}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    Command::new("explorer")
        .arg(path)
        .spawn()
        .map_err(|e| format!("Failed to open Explorer: {e}"))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map_err(|e| format!("Failed to open file manager: {e}"))?;
    Ok(())
}
