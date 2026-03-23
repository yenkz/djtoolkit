use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{Manager, State};

use crate::config::{self, AppConfig};
use crate::daemon::{self, DaemonManager};

/// Holds the OAuth JWT once the callback is intercepted.
pub struct OAuthState {
    pub jwt: Arc<Mutex<Option<String>>>,
}

impl OAuthState {
    pub fn new() -> Self {
        Self {
            jwt: Arc::new(Mutex::new(None)),
        }
    }
}

/// The Supabase project URL for OAuth (set at build time via SUPABASE_URL env var).
const SUPABASE_URL: &str = match option_env!("SUPABASE_URL") {
    Some(url) => url,
    None => "",
};

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
// OAuth authentication
// ---------------------------------------------------------------------------

/// Open a Supabase OAuth window. The `on_navigation` callback intercepts
/// the `djtoolkit://` callback URL and extracts the JWT access token.
#[tauri::command]
pub fn start_oauth(app: tauri::AppHandle, oauth: State<'_, OAuthState>) -> Result<(), String> {
    if SUPABASE_URL.is_empty() {
        return Err("SUPABASE_URL not set at build time. Set the env var and rebuild.".into());
    }

    // Clear any previous result
    *oauth.jwt.lock().unwrap() = None;

    let auth_url = format!(
        "{}/auth/v1/authorize?provider=google&redirect_to={}",
        SUPABASE_URL,
        "djtoolkit%3A%2F%2Fauth%2Fcallback"
    );

    let jwt_ref = Arc::clone(&oauth.jwt);

    tauri::WebviewWindowBuilder::new(
        &app,
        "oauth",
        tauri::WebviewUrl::External(auth_url.parse().map_err(|e| format!("Bad URL: {e}"))?),
    )
    .title("Sign in to djtoolkit")
    .inner_size(500.0, 700.0)
    .center()
    .on_navigation(move |url| {
        if url.scheme() == "djtoolkit" {
            // Extract access_token from the URL fragment
            if let Some(fragment) = url.fragment() {
                for param in fragment.split('&') {
                    if let Some(token) = param.strip_prefix("access_token=") {
                        if let Ok(mut jwt) = jwt_ref.lock() {
                            *jwt = Some(token.to_string());
                        }
                        break;
                    }
                }
            }
            return false; // prevent navigation to custom scheme
        }
        true
    })
    .build()
    .map_err(|e| format!("Failed to create OAuth window: {e}"))?;

    Ok(())
}

/// Check if the OAuth callback has been received. Returns the JWT if available.
#[tauri::command]
pub fn check_oauth_result(oauth: State<'_, OAuthState>) -> Option<String> {
    oauth.jwt.lock().ok().and_then(|guard| guard.clone())
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
