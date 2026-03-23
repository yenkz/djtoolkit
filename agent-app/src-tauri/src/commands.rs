use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{Manager, State};

use crate::config::{self, AppConfig};
use crate::daemon::{self, DaemonManager};

/// The Supabase project URL (set at build time via SUPABASE_URL env var).
const SUPABASE_URL: &str = match option_env!("SUPABASE_URL") {
    Some(url) => url,
    None => "",
};

/// The Supabase anon key (set at build time via SUPABASE_ANON_KEY env var).
const SUPABASE_ANON_KEY: &str = match option_env!("SUPABASE_ANON_KEY") {
    Some(key) => key,
    None => "",
};

/// The cloud API URL for agent registration.
const CLOUD_URL: &str = "https://www.djtoolkit.net";

// ---------------------------------------------------------------------------
// Local logging — writes to agent.log in the config directory
// ---------------------------------------------------------------------------

fn write_log(level: &str, msg: &str) {
    let log_path = daemon::get_config_dir().join("agent.log");
    let _ = fs::create_dir_all(daemon::get_config_dir());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let line = format!("[{now}] {level}: {msg}\n");
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(line.as_bytes())
        });
}

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
    write_log("INFO", "Starting agent daemon...");
    let result = daemon::start_daemon(&app, &manager);
    match &result {
        Ok(()) => write_log("INFO", "Agent daemon started"),
        Err(e) => write_log("ERROR", &format!("Failed to start daemon: {e}")),
    }
    result
}

#[tauri::command]
pub fn stop_agent(manager: State<'_, DaemonManager>) -> Result<(), String> {
    write_log("INFO", "Stopping agent daemon...");
    let result = daemon::stop_daemon(&manager);
    match &result {
        Ok(()) => write_log("INFO", "Agent daemon stopped"),
        Err(e) => write_log("WARN", &format!("Stop daemon: {e}")),
    }
    result
}

#[tauri::command]
pub fn pause_agent(manager: State<'_, DaemonManager>) -> Result<(), String> {
    write_log("INFO", "Pausing agent daemon...");
    let result = daemon::pause_daemon(&manager);
    match &result {
        Ok(()) => write_log("INFO", "Agent daemon paused"),
        Err(e) => write_log("WARN", &format!("Pause daemon: {e}")),
    }
    result
}

#[tauri::command]
pub fn resume_agent(manager: State<'_, DaemonManager>) -> Result<(), String> {
    write_log("INFO", "Resuming agent daemon...");
    let result = daemon::resume_daemon(&manager);
    match &result {
        Ok(()) => write_log("INFO", "Agent daemon resumed"),
        Err(e) => write_log("WARN", &format!("Resume daemon: {e}")),
    }
    result
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
// Authentication — email/password via Supabase REST API
// ---------------------------------------------------------------------------

/// Sign in with email/password via Supabase, then register the agent.
/// Returns the agent API key on success.
#[tauri::command]
pub fn sign_in(email: String, password: String) -> Result<SignInResult, String> {
    if SUPABASE_URL.is_empty() || SUPABASE_ANON_KEY.is_empty() {
        return Err("SUPABASE_URL or SUPABASE_ANON_KEY not set at build time".into());
    }

    write_log("INFO", &format!("Signing in as {email}..."));

    // Step 1: Authenticate with Supabase
    let auth_url = format!("{}/auth/v1/token?grant_type=password", SUPABASE_URL);
    let auth_body = serde_json::json!({
        "email": email,
        "password": password,
    });

    let auth_json: serde_json::Value = ureq::post(&auth_url)
        .set("apikey", SUPABASE_ANON_KEY)
        .set("Content-Type", "application/json")
        .send_json(auth_body)
        .map_err(|e| format!("Authentication failed: {e}"))?
        .into_json()
        .map_err(|e| format!("Failed to parse auth response: {e}"))?;

    let access_token = auth_json["access_token"]
        .as_str()
        .ok_or("No access_token in auth response")?
        .to_string();

    let user_email = auth_json["user"]["email"]
        .as_str()
        .unwrap_or(&email)
        .to_string();

    write_log("INFO", &format!("Authenticated as {user_email}"));

    // Step 2: Register agent with cloud API
    let register_url = format!("{}/api/agents/register", CLOUD_URL);
    let machine_name = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "My Computer".into());

    let reg_body = serde_json::json!({
        "machine_name": machine_name,
    });

    let reg_json: serde_json::Value = ureq::post(&register_url)
        .set("Authorization", &format!("Bearer {access_token}"))
        .set("Content-Type", "application/json")
        .send_json(reg_body)
        .map_err(|e| format!("Agent registration failed: {e}"))?
        .into_json()
        .map_err(|e| format!("Failed to parse registration response: {e}"))?;

    let api_key = reg_json["api_key"]
        .as_str()
        .ok_or("No api_key in registration response")?
        .to_string();

    write_log("INFO", "Agent registered successfully");

    Ok(SignInResult {
        api_key,
        email: user_email,
    })
}

#[derive(serde::Serialize)]
pub struct SignInResult {
    pub api_key: String,
    pub email: String,
}

// ---------------------------------------------------------------------------
// Agent headless configuration (setup wizard)
// ---------------------------------------------------------------------------

/// Save agent credentials collected by the setup wizard.
/// Writes config.toml and a credentials file in the config directory.
/// The Python daemon reads these on startup.
#[tauri::command]
pub fn configure_agent(
    api_key: String,
    slsk_user: String,
    slsk_pass: String,
) -> Result<(), String> {
    let config_dir = daemon::get_config_dir();
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {e}"))?;

    // Save the main config file
    let cfg = AppConfig::default();
    config::save_config(&cfg)?;

    // Save credentials to a separate file that the Python daemon reads
    let creds = serde_json::json!({
        "api_key": api_key,
        "slsk_user": slsk_user,
        "slsk_pass": slsk_pass,
    });
    let creds_path = config_dir.join("credentials.json");
    fs::write(&creds_path, serde_json::to_string_pretty(&creds).unwrap())
        .map_err(|e| format!("Failed to write credentials: {e}"))?;

    write_log("INFO", "Agent configured successfully (credentials saved)");
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
