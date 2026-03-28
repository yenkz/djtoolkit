use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::daemon::get_config_dir;

/// Application configuration, persisted as TOML.
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

    /// Agent API key (non-sensitive identifier, stored here for Settings display).
    /// The canonical copy is in the OS keychain; this is kept in sync by configure-headless.
    #[serde(default)]
    pub api_key: String,

    /// Soulseek username (non-sensitive, stored for display in Settings).
    #[serde(default)]
    pub slsk_username: String,
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
            api_key: String::new(),
            slsk_username: String::new(),
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

/// Load config from disk. Returns defaults if the file doesn't exist.
pub fn load_config() -> Result<AppConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(AppConfig::default());
    }

    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))?;

    toml::from_str::<AppConfig>(&contents).map_err(|e| format!("Failed to parse config: {e}"))
}

/// Save config to disk (creates the config directory if needed).
pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let dir = get_config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {e}"))?;

    let contents =
        toml::to_string_pretty(config).map_err(|e| format!("Failed to serialize config: {e}"))?;

    fs::write(config_path(), contents).map_err(|e| format!("Failed to write config: {e}"))
}
