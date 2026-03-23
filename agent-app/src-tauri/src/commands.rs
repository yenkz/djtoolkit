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

/// Holds the auth result (JWT) from browser-based sign-in.
pub struct AuthState {
    pub jwt: Arc<Mutex<Option<String>>>,
}

impl AuthState {
    pub fn new() -> Self {
        Self {
            jwt: Arc::new(Mutex::new(None)),
        }
    }
}

/// Open the web app's agent auth page in the system browser.
/// Starts a localhost callback server as a fallback for when the
/// `djtoolkit://` deep link scheme isn't registered on the system.
/// The web page tries the deep link first, then falls back to localhost.
#[tauri::command]
pub fn start_browser_auth(auth: State<'_, AuthState>) -> Result<(), String> {
    *auth.jwt.lock().unwrap() = None;

    // Start localhost callback server (fallback for deep link)
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind: {e}"))?;
    let port = listener.local_addr().unwrap().port();

    let jwt_ref = Arc::clone(&auth.jwt);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(mut stream) => {
                    use std::io::{Read, Write};
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    if n == 0 { continue; }
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let first = req.lines().next().unwrap_or("");

                    if first.starts_with("GET /callback") {
                        // Extract token from query params
                        if let Some(qs) = first.find('?') {
                            let end = first.rfind(' ').unwrap_or(first.len());
                            let query = &first[qs + 1..end];
                            for param in query.split('&') {
                                if let Some(token) = param.strip_prefix("token=") {
                                    if let Ok(mut jwt) = jwt_ref.lock() {
                                        *jwt = Some(token.to_string());
                                    }
                                    write_log("INFO", "Auth: received token via localhost callback");
                                    break;
                                }
                            }
                        }
                        let html = r#"<!DOCTYPE html><html><head><title>djtoolkit</title>
<style>body{font-family:system-ui;background:#1a1a2e;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
h2{color:#4caf50}</style></head><body>
<div style="text-align:center"><h2>&#10003; Authenticated!</h2><p>You can close this tab.</p></div>
</body></html>"#;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
                            html.len(), html
                        );
                        let _ = stream.write_all(resp.as_bytes());
                        let _ = stream.flush();
                        break;
                    } else {
                        let resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                        let _ = stream.write_all(resp.as_bytes());
                        let _ = stream.flush();
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Open the web app with both callback options
    let auth_url = format!("{}/auth/agent?port={}", CLOUD_URL, port);
    open::that(&auth_url).map_err(|e| format!("Failed to open browser: {e}"))?;
    write_log("INFO", &format!("Browser auth: opened web app (localhost port {port})"));
    Ok(())
}

/// Called by the deep-link handler when `djtoolkit://auth/callback` is received.
/// Extracts the JWT, registers the agent, and stores the API key.
pub fn handle_auth_callback(url: &str, auth: &AuthState) {
    write_log("INFO", &format!("Auth callback: {}", &url[..url.len().min(60)]));

    if let Some(fragment_start) = url.find('#') {
        let fragment = &url[fragment_start + 1..];
        for param in fragment.split('&') {
            if let Some(token) = param.strip_prefix("access_token=") {
                // Register agent
                let register_url = format!("{}/api/agents/register", CLOUD_URL);
                let machine_name = hostname::get()
                    .map(|h| h.to_string_lossy().to_string())
                    .unwrap_or_else(|_| "My Computer".into());

                match ureq::post(&register_url)
                    .set("Authorization", &format!("Bearer {token}"))
                    .set("Content-Type", "application/json")
                    .send_json(serde_json::json!({ "machine_name": machine_name }))
                {
                    Ok(resp) => {
                        if let Ok(json) = resp.into_json::<serde_json::Value>() {
                            if let Some(api_key) = json["api_key"].as_str() {
                                let _ = store_keychain("agent-api-key", api_key);
                                if let Ok(mut jwt) = auth.jwt.lock() {
                                    *jwt = Some(api_key.to_string());
                                }
                                write_log("INFO", "Agent registered via browser auth");
                                return;
                            }
                        }
                        write_log("ERROR", "Registration response missing api_key");
                    }
                    Err(e) => {
                        write_log("ERROR", &format!("Agent registration failed: {e}"));
                    }
                }
                return;
            }
        }
    }
    write_log("WARN", "Auth callback: no access_token in URL");
}

/// Check if browser auth completed. Returns the API key if available.
#[tauri::command]
pub fn check_auth_result(auth: State<'_, AuthState>) -> Option<String> {
    auth.jwt.lock().ok().and_then(|guard| guard.clone())
}

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

    // Store the API key in the keychain so the Python daemon can read it
    store_keychain("agent-api-key", &api_key)?;
    write_log("INFO", "Agent registered successfully (API key stored in keychain)");

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
/// Writes config.toml and stores secrets in the OS keychain
/// (same format as the Python daemon's keychain.py).
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

    // Store credentials in the OS keychain using the `keyring` CLI convention
    // Service: "djtoolkit", Account: "agent-api-key" / "soulseek-username" / etc.
    // This matches djtoolkit/agent/keychain.py exactly.
    store_keychain("agent-api-key", &api_key)?;
    store_keychain("soulseek-username", &slsk_user)?;
    store_keychain("soulseek-password", &slsk_pass)?;

    write_log("INFO", "Agent configured (credentials saved to keychain)");
    Ok(())
}

/// Store a secret in both the OS keychain AND a credentials file.
/// The file fallback ensures the Python daemon can always read credentials,
/// even if the Rust keychain backend stores them differently.
fn store_keychain(account: &str, value: &str) -> Result<(), String> {
    // Try OS keychain (best effort)
    match keyring::Entry::new("djtoolkit", account) {
        Ok(entry) => {
            let _ = entry.set_password(value);
        }
        Err(_) => {} // Keychain unavailable, file fallback below
    }

    // Also write to credentials file (Python daemon reads this as fallback)
    let config_dir = daemon::get_config_dir();
    let creds_path = config_dir.join("credentials.json");

    // Read existing credentials or start fresh
    let mut creds: serde_json::Value = if creds_path.exists() {
        fs::read_to_string(&creds_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    creds[account] = serde_json::Value::String(value.to_string());
    fs::write(&creds_path, serde_json::to_string_pretty(&creds).unwrap())
        .map_err(|e| format!("Failed to write credentials file: {e}"))?;

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
