//! OS keychain integration for storing agent credentials.
//!
//! Uses the `keyring` crate for cross-platform credential storage:
//! - macOS: Keychain Services (native API)
//! - Windows: Credential Manager (native API)
//! - Linux: Secret Service / libsecret

use keyring::Entry;

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
    let entry = Entry::new(SERVICE, account)
        .map_err(|e| format!("Keychain error for {account}: {e}"))?;
    entry
        .set_password(password)
        .map_err(|e| format!("Failed to store {account}: {e}"))?;
    Ok(())
}

/// Retrieve a credential from the OS keychain. Returns None if not found.
pub fn get(account: &str) -> Option<String> {
    let entry = Entry::new(SERVICE, account).ok()?;
    entry.get_password().ok()
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
