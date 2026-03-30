use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::daemon::get_config_dir;

/// Agent section of the config file (`[agent]` in TOML).
/// This is the primary configuration read by both the Tauri app and the Python daemon.
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
    /// The canonical copy is in the OS keychain; this is kept in sync by configure_agent.
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

pub fn default_downloads_dir() -> String {
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

/// Full config file structure with `[agent]` section.
/// The Python daemon reads this format.
#[derive(Debug, Serialize, Deserialize)]
struct FullConfig {
    #[serde(default)]
    agent: AppConfig,
}

/// Path to the config file.
pub fn config_path() -> PathBuf {
    get_config_dir().join("config.toml")
}

/// Returns `true` if the config file already exists on disk.
pub fn config_exists() -> bool {
    config_path().exists()
}

/// Path to the onboarding sentinel file.
fn onboarding_path() -> PathBuf {
    get_config_dir().join("onboarding_done")
}

/// Returns `true` if the onboarding wizard has been completed at least once.
pub fn onboarding_complete() -> bool {
    onboarding_path().exists()
}

/// Create the sentinel file to mark onboarding as complete.
pub fn mark_onboarding_complete() -> Result<(), String> {
    let dir = get_config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    fs::write(onboarding_path(), "").map_err(|e| format!("Failed to write sentinel: {e}"))
}

/// Load config from disk. Supports both flat format (legacy) and `[agent]` section format.
pub fn load_config() -> Result<AppConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(AppConfig::default());
    }

    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))?;

    // Try nested [agent] format first (written by configure_agent)
    if let Ok(full) = toml::from_str::<FullConfig>(&contents) {
        // Check if the [agent] section actually had content (not just defaults)
        if contents.contains("[agent]") {
            return Ok(full.agent);
        }
    }

    // Fall back to flat format (legacy)
    toml::from_str::<AppConfig>(&contents).map_err(|e| format!("Failed to parse config: {e}"))
}

/// Save config to disk in the `[agent]` section format (Python-compatible).
/// Also writes [soulseek], [fingerprint], [cover_art] sections for the daemon.
pub fn save_config(config: &AppConfig) -> Result<(), String> {
    write_agent_config(config)
}

/// Write the full config.toml in the format the Python daemon expects.
pub fn write_agent_config(config: &AppConfig) -> Result<(), String> {
    let dir = get_config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {e}"))?;

    // Normalize backslashes for TOML compatibility (Windows paths)
    let downloads_dir = config.downloads_dir.replace('\\', "/");

    let contents = format!(
        r#"[agent]
cloud_url = "{cloud_url}"
poll_interval_sec = {poll_interval}
max_concurrent_jobs = {max_concurrent}
downloads_dir = "{downloads_dir}"
api_key = "{api_key}"
slsk_username = "{slsk_username}"

[soulseek]
search_timeout_sec = 15
download_timeout_sec = 300

[fingerprint]
enabled = true

[cover_art]
sources = "coverart itunes deezer"
"#,
        cloud_url = config.cloud_url,
        poll_interval = config.poll_interval_sec as u32,
        max_concurrent = config.max_concurrent_jobs,
        downloads_dir = downloads_dir,
        api_key = config.api_key,
        slsk_username = config.slsk_username,
    );

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
    fn load_nested_agent_format() {
        let toml_str = r#"
[agent]
cloud_url = "https://custom.example.com"
poll_interval_sec = 60
max_concurrent_jobs = 4
downloads_dir = "/tmp/downloads"
api_key = "djt_test123"
slsk_username = "testuser"

[soulseek]
search_timeout_sec = 15
"#;
        let full: FullConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(full.agent.cloud_url, "https://custom.example.com");
        assert_eq!(full.agent.poll_interval_sec, 60.0);
        assert_eq!(full.agent.api_key, "djt_test123");
        assert_eq!(full.agent.slsk_username, "testuser");
    }

    #[test]
    fn load_flat_format_legacy() {
        let toml_str = r#"
cloud_url = "https://custom.example.com"
poll_interval_sec = 60.0
"#;
        let cfg: AppConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(cfg.cloud_url, "https://custom.example.com");
        assert_eq!(cfg.poll_interval_sec, 60.0);
        assert_eq!(cfg.max_concurrent_jobs, 2); // default
    }

    #[test]
    fn config_path_is_inside_config_dir() {
        use crate::daemon::get_config_dir;
        let path = config_path();
        assert_eq!(path.parent().unwrap(), get_config_dir().as_path());
        assert_eq!(path.file_name().unwrap().to_str().unwrap(), "config.toml");
    }

    #[test]
    fn onboarding_path_is_inside_config_dir() {
        let path = onboarding_path();
        assert_eq!(path.parent().unwrap(), get_config_dir().as_path());
        assert_eq!(path.file_name().unwrap().to_str().unwrap(), "onboarding_done");
    }
}
