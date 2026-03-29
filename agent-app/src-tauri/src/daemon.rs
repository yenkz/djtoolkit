use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

/// Daemon lifecycle states.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum DaemonState {
    Stopped,
    Starting,
    Running,
    Paused,
}

impl DaemonState {
    pub fn as_str(&self) -> &'static str {
        match self {
            DaemonState::Stopped => "stopped",
            DaemonState::Starting => "starting",
            DaemonState::Running => "running",
            DaemonState::Paused => "paused",
        }
    }
}

/// Thread-safe wrapper around DaemonState for Tauri managed state.
pub struct DaemonManager {
    pub state: Mutex<DaemonState>,
}

impl DaemonManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(DaemonState::Stopped),
        }
    }
}

/// Returns the platform-appropriate config directory.
/// - macOS:   `~/.djtoolkit/`
/// - Windows: `%APPDATA%/djtoolkit/`
/// - Linux:   `~/.djtoolkit/`
pub fn get_config_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("djtoolkit")
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        home.join(".djtoolkit")
    }
}

/// Path to the PID file.
fn pid_file() -> PathBuf {
    get_config_dir().join("agent.pid")
}

/// Path to the pause sentinel file.
fn pause_file() -> PathBuf {
    get_config_dir().join("agent_paused")
}

/// Resolve the bundled sidecar binary path.
/// Tauri strips the target-triple suffix when bundling externalBin entries, so the binary
/// is placed in Contents/MacOS/ as plain `djtoolkit` (not `djtoolkit-aarch64-apple-darwin`).
pub fn get_sidecar_path(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let binary_name = "djtoolkit.exe";
    #[cfg(not(target_os = "windows"))]
    let binary_name = "djtoolkit";

    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("Failed to get current exe path: {e}"))?
        .parent()
        .ok_or_else(|| "Failed to get exe parent directory".to_string())?
        .to_path_buf();

    let path = exe_dir.join(binary_name);
    if path.exists() {
        return Ok(path);
    }

    Err(format!("Sidecar not found at: {}", path.display()))
}

/// Start the daemon as a detached child process.
/// Command: `<sidecar> agent run`
/// The PID is written to `{config_dir}/agent.pid`.
pub fn start_daemon(app: &tauri::AppHandle, manager: &DaemonManager) -> Result<(), String> {
    let mut state = manager.state.lock().map_err(|e| format!("Lock error: {e}"))?;
    if *state == DaemonState::Running || *state == DaemonState::Starting {
        return Err("Daemon is already running or starting".into());
    }

    *state = DaemonState::Starting;

    let sidecar = get_sidecar_path(app)?;
    let config_dir = get_config_dir();
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create config dir: {e}"))?;

    // Remove stale pause file so the daemon starts in active mode.
    let _ = fs::remove_file(pause_file());

    let child = spawn_detached(&sidecar, &["agent", "run"])?;
    let pid = child;

    // Write PID file.
    fs::write(pid_file(), pid.to_string())
        .map_err(|e| format!("Failed to write PID file: {e}"))?;

    *state = DaemonState::Running;
    Ok(())
}

/// Spawn a detached process that survives the parent's exit.
/// Returns the child PID.
#[cfg(unix)]
fn spawn_detached(program: &PathBuf, args: &[&str]) -> Result<u32, String> {
    use std::process::{Command, Stdio};

    let child = unsafe {
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .pre_exec(|| {
                // Create a new session so the child is fully detached.
                libc::setsid();
                Ok(())
            })
            .spawn()
            .map_err(|e| format!("Failed to spawn daemon: {e}"))?
    };

    Ok(child.id())
}

#[cfg(target_os = "windows")]
fn spawn_detached(program: &PathBuf, args: &[&str]) -> Result<u32, String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    const DETACH_FLAGS: u32 = 0x00000008 | 0x00000200 | 0x08000000;

    let child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACH_FLAGS)
        .spawn()
        .map_err(|e| format!("Failed to spawn daemon: {e}"))?;

    Ok(child.id())
}

/// Stop the daemon by reading the PID file and sending a signal.
pub fn stop_daemon(manager: &DaemonManager) -> Result<(), String> {
    let mut state = manager.state.lock().map_err(|e| format!("Lock error: {e}"))?;

    let pid_path = pid_file();
    if !pid_path.exists() {
        *state = DaemonState::Stopped;
        return Err("No PID file found; daemon may not be running".into());
    }

    let pid_str = fs::read_to_string(&pid_path)
        .map_err(|e| format!("Failed to read PID file: {e}"))?;
    let pid: u32 = pid_str
        .trim()
        .parse()
        .map_err(|e| format!("Invalid PID in file: {e}"))?;

    kill_process(pid)?;

    let _ = fs::remove_file(&pid_path);
    let _ = fs::remove_file(pause_file());
    *state = DaemonState::Stopped;
    Ok(())
}

/// Send SIGTERM (Unix) or TerminateProcess (Windows) to a PID.
#[cfg(unix)]
fn kill_process(pid: u32) -> Result<(), String> {
    let ret = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    if ret != 0 {
        return Err(format!(
            "Failed to send SIGTERM to PID {pid}: errno {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn kill_process(pid: u32) -> Result<(), String> {
    use std::process::Command;
    let status = Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .status()
        .map_err(|e| format!("Failed to run taskkill: {e}"))?;
    if !status.success() {
        return Err(format!("taskkill failed for PID {pid}"));
    }
    Ok(())
}

/// Pause the daemon by creating a sentinel file.
/// The Python agent is expected to poll for this file and idle when it exists.
pub fn pause_daemon(manager: &DaemonManager) -> Result<(), String> {
    let mut state = manager.state.lock().map_err(|e| format!("Lock error: {e}"))?;
    if *state != DaemonState::Running {
        return Err("Daemon is not running".into());
    }

    let config_dir = get_config_dir();
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    fs::write(pause_file(), "").map_err(|e| format!("Failed to write pause file: {e}"))?;

    *state = DaemonState::Paused;
    Ok(())
}

/// Resume the daemon by removing the pause sentinel file.
pub fn resume_daemon(manager: &DaemonManager) -> Result<(), String> {
    let mut state = manager.state.lock().map_err(|e| format!("Lock error: {e}"))?;
    if *state != DaemonState::Paused {
        return Err("Daemon is not paused".into());
    }

    let _ = fs::remove_file(pause_file());
    *state = DaemonState::Running;
    Ok(())
}

/// Check whether the PID from the PID file is still alive and update state accordingly.
pub fn check_daemon_health(manager: &DaemonManager) {
    let mut state = manager.state.lock().unwrap_or_else(|e| e.into_inner());

    let pid_path = pid_file();
    if !pid_path.exists() {
        if *state != DaemonState::Stopped {
            *state = DaemonState::Stopped;
        }
        return;
    }

    let pid_str = match fs::read_to_string(&pid_path) {
        Ok(s) => s,
        Err(_) => {
            *state = DaemonState::Stopped;
            return;
        }
    };

    let pid: u32 = match pid_str.trim().parse() {
        Ok(p) => p,
        Err(_) => {
            *state = DaemonState::Stopped;
            return;
        }
    };

    if is_process_alive(pid) {
        // Check if paused via sentinel file.
        if pause_file().exists() {
            *state = DaemonState::Paused;
        } else if *state == DaemonState::Stopped || *state == DaemonState::Starting {
            *state = DaemonState::Running;
        }
    } else {
        // Process died — clean up.
        let _ = fs::remove_file(&pid_path);
        let _ = fs::remove_file(pause_file());
        *state = DaemonState::Stopped;
    }
}

/// Check if a process with the given PID is alive.
#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    // kill(pid, 0) checks existence without sending a signal.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(target_os = "windows")]
fn is_process_alive(pid: u32) -> bool {
    use std::process::Command;
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|o| {
            let out = String::from_utf8_lossy(&o.stdout);
            out.contains(&pid.to_string())
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_state_display() {
        assert_eq!(DaemonState::Stopped.as_str(), "stopped");
        assert_eq!(DaemonState::Starting.as_str(), "starting");
        assert_eq!(DaemonState::Running.as_str(), "running");
        assert_eq!(DaemonState::Paused.as_str(), "paused");
    }

    #[test]
    fn manager_initial_state_is_stopped() {
        let mgr = DaemonManager::new();
        let state = mgr.state.lock().unwrap();
        assert_eq!(*state, DaemonState::Stopped);
    }

    #[test]
    fn config_dir_has_correct_leaf_name() {
        let dir = get_config_dir();
        let name = dir.file_name().unwrap().to_str().unwrap();
        #[cfg(target_os = "windows")]
        assert_eq!(name, "djtoolkit");
        #[cfg(not(target_os = "windows"))]
        assert_eq!(name, ".djtoolkit");
    }

    #[test]
    fn pid_file_is_inside_config_dir() {
        let config_dir = get_config_dir();
        let pid = pid_file();
        assert_eq!(pid.parent().unwrap(), config_dir.as_path());
        assert_eq!(pid.file_name().unwrap().to_str().unwrap(), "agent.pid");
    }

    #[test]
    fn pause_file_is_inside_config_dir() {
        let config_dir = get_config_dir();
        let pause = pause_file();
        assert_eq!(pause.parent().unwrap(), config_dir.as_path());
        assert_eq!(pause.file_name().unwrap().to_str().unwrap(), "agent_paused");
    }

    #[test]
    fn daemon_state_equality() {
        assert_eq!(DaemonState::Stopped, DaemonState::Stopped);
        assert_ne!(DaemonState::Stopped, DaemonState::Running);
        assert_ne!(DaemonState::Running, DaemonState::Paused);
    }
}

