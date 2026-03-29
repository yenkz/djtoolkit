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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_has_expected_values() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.cloud_url, "https://www.djtoolkit.net");
        assert_eq!(cfg.poll_interval_sec, 30.0);
        assert_eq!(cfg.max_concurrent_jobs, 2);
        assert!(cfg.launch_at_startup);
        assert!(cfg.api_key.is_empty());
        assert!(cfg.slsk_username.is_empty());
        assert!(!cfg.downloads_dir.is_empty(), "downloads_dir should not be empty");
    }

    #[test]
    fn config_toml_roundtrip() {
        let cfg = AppConfig {
            cloud_url: "https://example.com".into(),
            poll_interval_sec: 15.0,
            max_concurrent_jobs: 4,
            downloads_dir: "/tmp/test-downloads".into(),
            launch_at_startup: false,
            api_key: "test-api-key".into(),
            slsk_username: "testuser".into(),
        };
        let serialized = toml::to_string_pretty(&cfg).unwrap();
        let deserialized: AppConfig = toml::from_str(&serialized).unwrap();
        assert_eq!(deserialized.cloud_url, cfg.cloud_url);
        assert_eq!(deserialized.poll_interval_sec, cfg.poll_interval_sec);
        assert_eq!(deserialized.max_concurrent_jobs, cfg.max_concurrent_jobs);
        assert_eq!(deserialized.downloads_dir, cfg.downloads_dir);
        assert_eq!(deserialized.launch_at_startup, cfg.launch_at_startup);
        assert_eq!(deserialized.api_key, cfg.api_key);
        assert_eq!(deserialized.slsk_username, cfg.slsk_username);
    }

    #[test]
    fn partial_toml_fills_missing_fields_with_defaults() {
        // Simulates a config written by an older version that is missing new fields.
        let partial = r#"
            cloud_url = "https://custom.example.com"
            poll_interval_sec = 60.0
        "#;
        let cfg: AppConfig = toml::from_str(partial).unwrap();
        assert_eq!(cfg.cloud_url, "https://custom.example.com");
        assert_eq!(cfg.poll_interval_sec, 60.0);
        assert_eq!(cfg.max_concurrent_jobs, 2);
        assert!(cfg.launch_at_startup);
        assert!(cfg.api_key.is_empty());
    }

    #[test]
    fn config_path_is_inside_config_dir() {
        use crate::daemon::get_config_dir;
        let path = config_path();
        assert_eq!(path.parent().unwrap(), get_config_dir().as_path());
        assert_eq!(path.file_name().unwrap().to_str().unwrap(), "config.toml");
    }
}
