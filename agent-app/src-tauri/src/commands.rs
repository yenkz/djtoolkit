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
// OAuth authentication via localhost callback server
// ---------------------------------------------------------------------------

/// Start a localhost HTTP server, open the Supabase OAuth URL in the system
/// browser, and wait for the callback with the JWT token.
#[tauri::command]
pub fn start_oauth(oauth: State<'_, OAuthState>) -> Result<u16, String> {
    if SUPABASE_URL.is_empty() {
        return Err("SUPABASE_URL not set at build time. Set the env var and rebuild.".into());
    }

    // Clear any previous result
    *oauth.jwt.lock().unwrap() = None;

    // Bind to a random available port
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind localhost server: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get port: {e}"))?
        .port();

    let jwt_ref = Arc::clone(&oauth.jwt);

    // Spawn a thread to handle the OAuth callback
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(mut stream) => {
                    use std::io::{Read, Write};
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    if n == 0 { continue; }
                    let request = String::from_utf8_lossy(&buf[..n]).to_string();
                    let first_line = request.lines().next().unwrap_or("");

                    if first_line.starts_with("GET /callback") {
                        // Check if Supabase sent an access_token as a query param
                        // (some flows put it here instead of the fragment)
                        let mut got_token = false;
                        if let Some(query_start) = first_line.find('?') {
                            let query_end = first_line.rfind(' ').unwrap_or(first_line.len());
                            let query = &first_line[query_start + 1..query_end];
                            for param in query.split('&') {
                                if let Some(token) = param.strip_prefix("access_token=") {
                                    if let Ok(mut jwt) = jwt_ref.lock() {
                                        *jwt = Some(token.to_string());
                                    }
                                    got_token = true;
                                    break;
                                }
                            }
                        }

                        // Serve callback page — JS extracts token from hash fragment
                        // (implicit flow) and POSTs it back
                        let html = format!(r#"<!DOCTYPE html>
<html><head><title>djtoolkit - Authenticated</title>
<style>
body {{ font-family: system-ui; background: #1a1a2e; color: #eee;
       display: flex; align-items: center; justify-content: center;
       min-height: 100vh; margin: 0; }}
.card {{ text-align: center; padding: 40px; }}
h2 {{ color: #4caf50; }}
.error {{ color: #ff6b6b; }}
</style></head><body>
<div class="card" id="card">
  <h2>Authenticating...</h2>
  <p>Please wait...</p>
</div>
<script>
(async function() {{
  const card = document.getElementById('card');
  try {{
    // Try implicit flow (token in hash fragment)
    let token = null;
    const hash = window.location.hash.substring(1);
    if (hash) {{
      const params = new URLSearchParams(hash);
      token = params.get('access_token');
    }}
    // Also check query params
    if (!token) {{
      const qp = new URLSearchParams(window.location.search);
      token = qp.get('access_token');
    }}
    if (token) {{
      await fetch('http://127.0.0.1:{port}/token', {{
        method: 'POST',
        body: token
      }});
      card.innerHTML = '<h2>&#10003; Authenticated!</h2><p>You can close this window and return to the app.</p>';
    }} else {{
      card.innerHTML = '<h2 class="error">No token received</h2><p>Hash: ' + window.location.hash + '</p><p>Search: ' + window.location.search + '</p>';
    }}
  }} catch(e) {{
    card.innerHTML = '<h2 class="error">Error</h2><p>' + e.message + '</p>';
  }}
}})();
</script></body></html>"#);
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
                            html.len(), html
                        );
                        let _ = stream.write_all(response.as_bytes());
                        let _ = stream.flush();

                        // If we already got the token from query params, we're done
                        if got_token {
                            write_log("INFO", "OAuth: got token from query params");
                            break;
                        }
                    } else if first_line.starts_with("POST /token") {
                        // Token posted from callback page JS (implicit flow)
                        if let Some(body_start) = request.find("\r\n\r\n") {
                            let token = request[body_start + 4..].trim().to_string();
                            if !token.is_empty() {
                                if let Ok(mut jwt) = jwt_ref.lock() {
                                    *jwt = Some(token);
                                }
                                write_log("INFO", "OAuth: got token from hash fragment");
                            }
                        }
                        let response = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nAccess-Control-Allow-Origin: *\r\n\r\nOK";
                        let _ = stream.write_all(response.as_bytes());
                        let _ = stream.flush();
                        break;
                    } else if first_line.starts_with("OPTIONS") {
                        let response = "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: 0\r\n\r\n";
                        let _ = stream.write_all(response.as_bytes());
                        let _ = stream.flush();
                    } else {
                        // favicon.ico, etc — ignore
                        let response = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                        let _ = stream.write_all(response.as_bytes());
                        let _ = stream.flush();
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Build the auth URL — force implicit flow so token comes in hash fragment
    let redirect = format!("http%3A%2F%2F127.0.0.1%3A{}%2Fcallback", port);
    let auth_url = format!(
        "{}/auth/v1/authorize?provider=google&redirect_to={}&flow_type=implicit",
        SUPABASE_URL, redirect
    );

    // Open in the system browser
    let _ = open::that(&auth_url);
    write_log("INFO", &format!("OAuth started on port {port}"));

    Ok(port)
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
