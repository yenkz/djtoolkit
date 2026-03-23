use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::daemon::get_config_dir;

/// Application configuration — combines config.toml + credentials.json
/// for the frontend. Credential fields are excluded from TOML serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// Cloud API URL.
    #[serde(default = "default_cloud_url")]
    pub cloud_url: String,

    /// How often the agent polls for new jobs (seconds).
    #[serde(default = "default_poll_interval")]
    pub poll_interval_sec: f64,

    /// Maximum number of concurrent pipeline jobs.
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent_jobs: u32,

    /// Directory where downloaded files are stored.
    #[serde(default = "default_downloads_dir")]
    pub downloads_dir: String,

    /// Whether the app should launch at system startup.
    #[serde(default = "default_launch_at_startup")]
    pub launch_at_startup: bool,

    // --- Credentials (stored in credentials.json, not config.toml) ---
    #[serde(default, skip_serializing)]
    pub slsk_username: String,
    #[serde(default, skip_serializing)]
    pub slsk_password: String,
    #[serde(default, skip_serializing)]
    pub acoustid_api_key: String,
    #[serde(default, skip_serializing)]
    pub api_key: String,
}

fn default_cloud_url() -> String {
    "https://www.djtoolkit.net".into()
}

fn default_poll_interval() -> f64 {
    30.0
}

fn default_max_concurrent() -> u32 {
    2
}

fn default_downloads_dir() -> String {
    let music = dirs::audio_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    music
        .join("djtoolkit")
        .join("downloads")
        .to_string_lossy()
        .into_owned()
}

fn default_launch_at_startup() -> bool {
    true
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            cloud_url: default_cloud_url(),
            poll_interval_sec: default_poll_interval(),
            max_concurrent_jobs: default_max_concurrent(),
            downloads_dir: default_downloads_dir(),
            launch_at_startup: default_launch_at_startup(),
            slsk_username: String::new(),
            slsk_password: String::new(),
            acoustid_api_key: String::new(),
            api_key: String::new(),
        }
    }
}

/// Path to the config file.
pub fn config_path() -> PathBuf {
    get_config_dir().join("config.toml")
}

/// Returns `true` if the config file already exists on disk.
pub fn config_exists() -> bool {
    config_path().exists()
}

/// Load config from disk + credentials from credentials.json.
pub fn load_config() -> Result<AppConfig, String> {
    let path = config_path();
    let mut cfg = if path.exists() {
        let contents =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))?;
        toml::from_str::<AppConfig>(&contents).map_err(|e| format!("Failed to parse config: {e}"))?
    } else {
        AppConfig::default()
    };

    // Merge credentials from credentials.json
    let creds_path = get_config_dir().join("credentials.json");
    if creds_path.exists() {
        if let Ok(contents) = fs::read_to_string(&creds_path) {
            if let Ok(creds) = serde_json::from_str::<serde_json::Value>(&contents) {
                cfg.api_key = creds["agent-api-key"].as_str().unwrap_or("").to_string();
                cfg.slsk_username = creds["soulseek-username"].as_str().unwrap_or("").to_string();
                cfg.slsk_password = creds["soulseek-password"].as_str().unwrap_or("").to_string();
                cfg.acoustid_api_key = creds["acoustid-key"].as_str().unwrap_or("").to_string();
            }
        }
    }

    Ok(cfg)
}

/// Save config to disk + credentials to credentials.json.
pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let dir = get_config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {e}"))?;

    // Save TOML (excludes credential fields via skip_serializing)
    let contents =
        toml::to_string_pretty(config).map_err(|e| format!("Failed to serialize config: {e}"))?;
    fs::write(config_path(), contents).map_err(|e| format!("Failed to write config: {e}"))?;

    // Save credentials separately
    let creds_path = dir.join("credentials.json");
    let creds = serde_json::json!({
        "agent-api-key": config.api_key,
        "soulseek-username": config.slsk_username,
        "soulseek-password": config.slsk_password,
        "acoustid-key": config.acoustid_api_key,
    });
    fs::write(&creds_path, serde_json::to_string_pretty(&creds).unwrap())
        .map_err(|e| format!("Failed to write credentials: {e}"))?;

    Ok(())
}
