use std::fs;
use std::io::{BufRead, BufReader};
use std::process::Command;

use tauri::State;

use crate::config::{self, AppConfig};
use crate::daemon::{self, DaemonManager};
use crate::keychain;

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
// Agent configuration (setup wizard) — pure Rust, no Python sidecar
// ---------------------------------------------------------------------------

/// Configure the agent by storing credentials in the OS keychain and writing
/// the config file. This replaces the Python `configure-headless` command to
/// avoid PyInstaller + macOS 15 quarantine/signing issues.
#[tauri::command]
pub fn configure_agent(
    api_key: String,
    slsk_user: String,
    slsk_pass: String,
    supabase_url: Option<String>,
    supabase_anon_key: Option<String>,
    agent_email: Option<String>,
    agent_password: Option<String>,
    _app: tauri::AppHandle,
) -> Result<(), String> {
    // Validate
    if api_key.is_empty() {
        return Err("Missing required field: api_key".into());
    }
    if !api_key.starts_with("djt_") {
        return Err("api_key must start with 'djt_'".into());
    }

    // Store credentials in OS keychain
    keychain::store(keychain::API_KEY, &api_key)?;
    keychain::store(keychain::SLSK_USERNAME, &slsk_user)?;
    keychain::store(keychain::SLSK_PASSWORD, &slsk_pass)?;

    if let Some(v) = supabase_url.filter(|s| !s.is_empty()) {
        keychain::store(keychain::SUPABASE_URL, &v)?;
    }
    if let Some(v) = supabase_anon_key.filter(|s| !s.is_empty()) {
        keychain::store(keychain::SUPABASE_ANON_KEY, &v)?;
    }
    if let Some(v) = agent_email.filter(|s| !s.is_empty()) {
        keychain::store(keychain::AGENT_EMAIL, &v)?;
    }
    if let Some(v) = agent_password.filter(|s| !s.is_empty()) {
        keychain::store(keychain::AGENT_PASSWORD, &v)?;
    }

    // Write config.toml (Python-compatible format)
    let mut cfg = config::load_config().unwrap_or_default();
    cfg.api_key = api_key;
    cfg.slsk_username = slsk_user;
    config::write_agent_config(&cfg)?;

    Ok(())
}

/// Re-authenticate from the Settings panel (no wizard).
/// Stores api_key + optional Supabase/auth credentials. Preserves existing
/// Soulseek credentials from the keychain.
#[tauri::command]
pub fn sign_in_from_settings(
    api_key: String,
    supabase_url: Option<String>,
    supabase_anon_key: Option<String>,
    agent_email: Option<String>,
    agent_password: Option<String>,
    _app: tauri::AppHandle,
) -> Result<(), String> {
    if api_key.is_empty() {
        return Err("Missing required field: api_key".into());
    }
    if !api_key.starts_with("djt_") {
        return Err("api_key must start with 'djt_'".into());
    }

    // Store credentials in OS keychain
    keychain::store(keychain::API_KEY, &api_key)?;

    if let Some(v) = supabase_url.filter(|s| !s.is_empty()) {
        keychain::store(keychain::SUPABASE_URL, &v)?;
    }
    if let Some(v) = supabase_anon_key.filter(|s| !s.is_empty()) {
        keychain::store(keychain::SUPABASE_ANON_KEY, &v)?;
    }
    if let Some(v) = agent_email.filter(|s| !s.is_empty()) {
        keychain::store(keychain::AGENT_EMAIL, &v)?;
    }
    if let Some(v) = agent_password.filter(|s| !s.is_empty()) {
        keychain::store(keychain::AGENT_PASSWORD, &v)?;
    }

    // Preserve existing soulseek username from keychain or config
    let slsk_username = keychain::get(keychain::SLSK_USERNAME)
        .or_else(|| {
            config::load_config()
                .ok()
                .map(|c| c.slsk_username)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_default();

    // Write config.toml
    let mut cfg = config::load_config().unwrap_or_default();
    cfg.api_key = api_key;
    cfg.slsk_username = slsk_username;
    config::write_agent_config(&cfg)?;

    Ok(())
}

/// Update Soulseek credentials from the Settings panel without re-running the wizard.
#[tauri::command]
pub fn update_credentials(
    slsk_user: String,
    slsk_pass: String,
    _app: tauri::AppHandle,
) -> Result<(), String> {
    let cfg = config::load_config()?;
    if cfg.api_key.is_empty() {
        return Err("Not signed in — please run the setup wizard first".into());
    }

    // Store in keychain
    keychain::store(keychain::SLSK_USERNAME, &slsk_user)?;
    keychain::store(keychain::SLSK_PASSWORD, &slsk_pass)?;

    // Update config.toml with new username
    let mut cfg = cfg;
    cfg.slsk_username = slsk_user;
    config::write_agent_config(&cfg)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Log viewer
// ---------------------------------------------------------------------------

/// Truncate `agent.log` so the viewer shows a clean slate.
#[tauri::command]
pub fn clear_log_file() -> Result<(), String> {
    let log_path = daemon::get_config_dir().join("agent.log");
    if log_path.exists() {
        fs::write(&log_path, "").map_err(|e| format!("Failed to clear log file: {e}"))?;
    }
    Ok(())
}

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
