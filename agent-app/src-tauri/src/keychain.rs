//! OS keychain integration for storing agent credentials.
//!
//! Uses platform-native CLI tools — no additional crate dependencies:
//! - macOS: `security` (Keychain Services)
//! - Windows: `cmdkey` + PowerShell (Credential Manager)

use std::process::Command;

const SERVICE: &str = "djtoolkit";

// Keychain account names (must match Python's keychain.py)
pub const API_KEY: &str = "agent-api-key";
pub const SLSK_USERNAME: &str = "soulseek-username";
pub const SLSK_PASSWORD: &str = "soulseek-password";
#[allow(dead_code)]
pub const ACOUSTID_KEY: &str = "acoustid-key";
pub const SUPABASE_URL: &str = "supabase-url";
pub const SUPABASE_ANON_KEY: &str = "supabase-anon-key";
pub const AGENT_EMAIL: &str = "agent-email";
pub const AGENT_PASSWORD: &str = "agent-password";

/// Store a credential in the OS keychain.
pub fn store(account: &str, password: &str) -> Result<(), String> {
    if password.is_empty() {
        return Ok(());
    }
    store_platform(account, password)
}

/// Retrieve a credential from the OS keychain. Returns None if not found.
pub fn get(account: &str) -> Option<String> {
    get_platform(account)
}

// ── macOS: Keychain Services via `security` CLI ─────────────────────────

#[cfg(target_os = "macos")]
fn store_platform(account: &str, password: &str) -> Result<(), String> {
    let status = Command::new("security")
        .args([
            "add-generic-password",
            "-a",
            account,
            "-s",
            SERVICE,
            "-w",
            password,
            "-U", // update if exists
        ])
        .output()
        .map_err(|e| format!("Failed to run security: {e}"))?;

    if !status.status.success() {
        let stderr = String::from_utf8_lossy(&status.stderr);
        return Err(format!("Keychain store failed for {account}: {stderr}"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn get_platform(account: &str) -> Option<String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            account,
            "-s",
            SERVICE,
            "-w", // print password only
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let password = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if password.is_empty() {
        None
    } else {
        Some(password)
    }
}

// ── Windows: Credential Manager via cmdkey + PowerShell ─────────────────

#[cfg(target_os = "windows")]
fn store_platform(account: &str, password: &str) -> Result<(), String> {
    let target = format!("{SERVICE}:{account}");
    let status = Command::new("cmdkey")
        .args([
            &format!("/generic:{target}"),
            &format!("/user:{account}"),
            &format!("/pass:{password}"),
        ])
        .output()
        .map_err(|e| format!("Failed to run cmdkey: {e}"))?;

    if !status.status.success() {
        let stderr = String::from_utf8_lossy(&status.stderr);
        return Err(format!("Credential store failed for {account}: {stderr}"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn get_platform(account: &str) -> Option<String> {
    let target = format!("{SERVICE}:{account}");
    // Use PowerShell to read the credential password via .NET interop
    let script = format!(
        "$c = Get-StoredCredential -Target '{target}' -ErrorAction SilentlyContinue; \
         if ($c) {{ $c.GetNetworkCredential().Password }} else {{ '' }}"
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let password = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if password.is_empty() {
        None
    } else {
        Some(password)
    }
}

// ── Linux fallback ──────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn store_platform(_account: &str, _password: &str) -> Result<(), String> {
    Err("Keychain not implemented for Linux".into())
}

#[cfg(target_os = "linux")]
fn get_platform(_account: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_python() {
        // These must match djtoolkit/agent/keychain.py
        assert_eq!(API_KEY, "agent-api-key");
        assert_eq!(SLSK_USERNAME, "soulseek-username");
        assert_eq!(SLSK_PASSWORD, "soulseek-password");
        assert_eq!(ACOUSTID_KEY, "acoustid-key");
        assert_eq!(SUPABASE_URL, "supabase-url");
        assert_eq!(SUPABASE_ANON_KEY, "supabase-anon-key");
        assert_eq!(AGENT_EMAIL, "agent-email");
        assert_eq!(AGENT_PASSWORD, "agent-password");
    }
}
