"""macOS Keychain credential storage for the djtoolkit agent.

Uses the ``keyring`` library which provides a cross-platform abstraction
over the system credential store (macOS Keychain, Windows Credential Locker,
Linux Secret Service).

All secrets are stored under the service name ``djtoolkit``.
"""

from __future__ import annotations

import keyring

SERVICE = "djtoolkit"

# Standard account names
API_KEY = "agent-api-key"
SLSK_USERNAME = "soulseek-username"
SLSK_PASSWORD = "soulseek-password"
ACOUSTID_KEY = "acoustid-key"
SUPABASE_URL = "supabase-url"
SUPABASE_ANON_KEY = "supabase-anon-key"
AGENT_EMAIL = "agent-email"
AGENT_PASSWORD = "agent-password"


def store_secret(account: str, value: str) -> None:
    """Store a secret in the system keychain."""
    keyring.set_password(SERVICE, account, value)


def get_secret(account: str) -> str | None:
    """Retrieve a secret from the system keychain.  Returns None if not found."""
    return keyring.get_password(SERVICE, account)


def delete_secret(account: str) -> None:
    """Delete a secret from the system keychain.  No-op if not found."""
    try:
        keyring.delete_password(SERVICE, account)
    except keyring.errors.PasswordDeleteError:
        pass


def has_secret(account: str) -> bool:
    """Check whether a secret exists in the keychain."""
    return get_secret(account) is not None


def store_agent_credentials(
    api_key: str,
    slsk_username: str,
    slsk_password: str,
    acoustid_key: str | None = None,
    supabase_url: str | None = None,
    supabase_anon_key: str | None = None,
    agent_email: str | None = None,
    agent_password: str | None = None,
) -> None:
    """Store all agent credentials in the keychain at once."""
    store_secret(API_KEY, api_key)
    store_secret(SLSK_USERNAME, slsk_username)
    store_secret(SLSK_PASSWORD, slsk_password)
    if acoustid_key:
        store_secret(ACOUSTID_KEY, acoustid_key)
    if supabase_url:
        store_secret(SUPABASE_URL, supabase_url)
    if supabase_anon_key:
        store_secret(SUPABASE_ANON_KEY, supabase_anon_key)
    if agent_email:
        store_secret(AGENT_EMAIL, agent_email)
    if agent_password:
        store_secret(AGENT_PASSWORD, agent_password)


def load_agent_credentials() -> dict[str, str | None]:
    """Load agent credentials from the keychain, falling back to credentials.json."""
    creds = {
        "api_key": get_secret(API_KEY),
        "slsk_username": get_secret(SLSK_USERNAME),
        "slsk_password": get_secret(SLSK_PASSWORD),
        "acoustid_key": get_secret(ACOUSTID_KEY),
        "supabase_url": get_secret(SUPABASE_URL),
        "supabase_anon_key": get_secret(SUPABASE_ANON_KEY),
        "agent_email": get_secret(AGENT_EMAIL),
        "agent_password": get_secret(AGENT_PASSWORD),
    }

    # Fall back to credentials.json (written by the Tauri desktop app)
    if not creds["api_key"]:
        from djtoolkit.agent.paths import config_dir
        import json
        creds_file = config_dir() / "credentials.json"
        if creds_file.exists():
            try:
                file_creds = json.loads(creds_file.read_text())
                for py_key, file_key in [
                    ("api_key", "agent-api-key"),
                    ("slsk_username", "soulseek-username"),
                    ("slsk_password", "soulseek-password"),
                    ("acoustid_key", "acoustid-key"),
                    ("supabase_url", "supabase-url"),
                    ("supabase_anon_key", "supabase-anon-key"),
                    ("agent_email", "agent-email"),
                    ("agent_password", "agent-password"),
                ]:
                    if not creds[py_key] and file_key in file_creds:
                        creds[py_key] = file_creds[file_key]
            except (json.JSONDecodeError, OSError):
                pass

    return creds


def clear_agent_credentials() -> None:
    """Remove all agent credentials from the keychain."""
    for account in (
        API_KEY, SLSK_USERNAME, SLSK_PASSWORD, ACOUSTID_KEY,
        SUPABASE_URL, SUPABASE_ANON_KEY, AGENT_EMAIL, AGENT_PASSWORD,
    ):
        delete_secret(account)
