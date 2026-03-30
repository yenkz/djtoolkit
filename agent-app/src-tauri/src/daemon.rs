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

/// Resolve the agent sidecar binary path.
///
/// macOS: The PyInstaller onedir output is extracted from a bundled tar to
/// `~/.djtoolkit/agent/djtoolkit` on first use. Running outside the .app bundle
/// avoids macOS 15's library validation issues with PyInstaller binaries.
///
/// Windows: The onefile binary is bundled as an externalBin in Contents/MacOS/.
pub fn get_sidecar_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        // The Python sidecar is bundled as a Tauri resource to avoid
        // naming conflicts with the Tauri app (both would be djtoolkit.exe).
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {e}"))?;
        let path = resource_dir.join("djtoolkit-sidecar.exe");
        if path.exists() {
            return Ok(path);
        }
        // Fallback: check exe directory (for dev builds)
        let exe_dir = std::env::current_exe()
            .map_err(|e| format!("Failed to get exe path: {e}"))?
            .parent()
            .ok_or_else(|| "Failed to get exe directory".to_string())?
            .to_path_buf();
        let fallback = exe_dir.join("djtoolkit-sidecar.exe");
        if fallback.exists() {
            return Ok(fallback);
        }
        return Err(format!(
            "Sidecar not found at: {} or {}",
            path.display(),
            fallback.display()
        ));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let agent_dir = get_config_dir().join("agent").join("djtoolkit");
        let binary = agent_dir.join("djtoolkit");

        if !binary.exists() {
            extract_agent(app, &agent_dir)?;
        }

        if binary.exists() {
            return Ok(binary);
        }
        Err(format!("Sidecar not found at: {}", binary.display()))
    }
}

/// Extract the PyInstaller onedir agent from the bundled tar resource.
/// Called once on first daemon start; subsequent starts reuse the extracted files.
#[cfg(not(target_os = "windows"))]
fn extract_agent(app: &tauri::AppHandle, dest: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    use tauri::Manager;

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;
    let tar_path = resource_dir.join("djtoolkit-agent.tar.gz");

    if !tar_path.exists() {
        return Err(format!(
            "Agent bundle not found at: {}",
            tar_path.display()
        ));
    }

    // Create the parent directory (e.g., ~/.djtoolkit/agent/)
    let parent = dest
        .parent()
        .ok_or_else(|| "Invalid destination path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create agent dir: {e}"))?;

    // Extract: tar xzf djtoolkit-agent.tar.gz -C ~/.djtoolkit/agent/
    // The tar contains a top-level `djtoolkit/` directory with the binary + _internal/
    let status = Command::new("tar")
        .args(["xzf"])
        .arg(&tar_path)
        .args(["-C"])
        .arg(parent)
        .status()
        .map_err(|e| format!("Failed to run tar: {e}"))?;

    if !status.success() {
        return Err("Failed to extract agent bundle".into());
    }

    // Make the binary executable
    let binary = dest.join("djtoolkit");
    if binary.exists() {
        let _ = Command::new("chmod").args(["+x"]).arg(&binary).status();
    }

    Ok(())
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

    // Use a closure so we can reset state on ANY error.
    let result = (|| -> Result<u32, String> {
        let sidecar = get_sidecar_path(app)?;
        let config_dir = get_config_dir();
        fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create config dir: {e}"))?;

        // Remove stale pause file so the daemon starts in active mode.
        let _ = fs::remove_file(pause_file());

        spawn_detached(&sidecar, &["agent", "run"])
    })();

    match result {
        Ok(pid) => {
            let _ = fs::write(pid_file(), pid.to_string());
            *state = DaemonState::Running;
            Ok(())
        }
        Err(e) => {
            *state = DaemonState::Stopped;
            Err(e)
        }
    }
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

    // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    // NOTE: DETACHED_PROCESS (0x8) must NOT be combined with
    // CREATE_NO_WINDOW (0x08000000) — they are mutually exclusive
    // per Microsoft docs. Combining them causes a visible CMD window
    // on Windows 10.
    const DETACH_FLAGS: u32 = 0x00000200 | 0x08000000;

    // Redirect stdout+stderr to agent.log so we capture Python startup
    // errors even if the logging module hasn't initialized yet.
    let log_path = get_config_dir().join("agent.log");
    let mut log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log file: {e}"))?;

    // Write diagnostic before spawning so we can debug sidecar issues
    use std::io::Write;
    let _ = writeln!(
        log_file,
        "Tauri: spawning sidecar: {:?} {:?}",
        program,
        args
    );

    let stdout_file = log_file;
    let stderr_file = stdout_file
        .try_clone()
        .map_err(|e| format!("Failed to clone log handle: {e}"))?;

    let child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
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

