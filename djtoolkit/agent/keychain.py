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
    """Store all agent credentials in the keychain and mirror to credentials.json.

    credentials.json is the primary source on Windows and a fallback elsewhere;
    if a stale file is left behind with an old api_key, load_agent_credentials()
    returns it before ever reaching the keychain. Rewriting it here keeps the
    two stores in sync after every reconfigure.
    """
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

    _sync_credentials_json(
        api_key=api_key,
        slsk_username=slsk_username,
        slsk_password=slsk_password,
        acoustid_key=acoustid_key,
        supabase_url=supabase_url,
        supabase_anon_key=supabase_anon_key,
        agent_email=agent_email,
        agent_password=agent_password,
    )


def _sync_credentials_json(**kwargs: str | None) -> None:
    """Write non-None credentials to credentials.json, preserving existing values.

    Falls back to keychain-only if the config dir can't be written to.
    """
    import json
    from djtoolkit.agent.paths import config_dir

    _KEY_MAP = {
        "api_key": "agent-api-key",
        "slsk_username": "soulseek-username",
        "slsk_password": "soulseek-password",
        "acoustid_key": "acoustid-key",
        "supabase_url": "supabase-url",
        "supabase_anon_key": "supabase-anon-key",
        "agent_email": "agent-email",
        "agent_password": "agent-password",
    }

    try:
        cfg_dir = config_dir()
        cfg_dir.mkdir(parents=True, exist_ok=True)
        creds_file = cfg_dir / "credentials.json"
        existing: dict[str, str] = {}
        if creds_file.exists():
            try:
                existing = json.loads(creds_file.read_text())
            except (json.JSONDecodeError, OSError):
                existing = {}
        for py_key, file_key in _KEY_MAP.items():
            value = kwargs.get(py_key)
            if value is not None:
                existing[file_key] = value
        creds_file.write_text(json.dumps(existing, indent=2))
    except OSError:
        pass


def _load_credentials_json() -> dict[str, str | None]:
    """Load credentials from credentials.json (written by the agent setup process).

    This is the primary credential source on Windows because PyInstaller
    may not bundle keyring backends correctly, and the Python ``keyring``
    library can be unreliable in frozen environments.
    """
    import json
    from djtoolkit.agent.paths import config_dir

    _KEY_MAP = [
        ("api_key", "agent-api-key"),
        ("slsk_username", "soulseek-username"),
        ("slsk_password", "soulseek-password"),
        ("acoustid_key", "acoustid-key"),
        ("supabase_url", "supabase-url"),
        ("supabase_anon_key", "supabase-anon-key"),
        ("agent_email", "agent-email"),
        ("agent_password", "agent-password"),
    ]

    creds: dict[str, str | None] = {k: None for k, _ in _KEY_MAP}
    creds_file = config_dir() / "credentials.json"
    if creds_file.exists():
        try:
            file_creds = json.loads(creds_file.read_text())
            for py_key, file_key in _KEY_MAP:
                if file_key in file_creds and file_creds[file_key]:
                    creds[py_key] = file_creds[file_key]
        except (json.JSONDecodeError, OSError):
            pass
    return creds


def load_agent_credentials() -> dict[str, str | None]:
    """Load agent credentials from credentials.json, then keychain.

    On Windows, credentials.json is tried first because the Python
    ``keyring`` library inside a PyInstaller bundle may not have the
    correct backend, and even when it does, the Rust ``keyring`` crate
    stores credentials under different target names.
    """
    # 1. Try credentials.json first (most reliable, especially on Windows)
    creds = _load_credentials_json()
    if creds.get("api_key"):
        return creds

    # 2. Fall back to system keychain (works on macOS, unreliable on Windows)
    keychain_creds = {
        "api_key": get_secret(API_KEY),
        "slsk_username": get_secret(SLSK_USERNAME),
        "slsk_password": get_secret(SLSK_PASSWORD),
        "acoustid_key": get_secret(ACOUSTID_KEY),
        "supabase_url": get_secret(SUPABASE_URL),
        "supabase_anon_key": get_secret(SUPABASE_ANON_KEY),
        "agent_email": get_secret(AGENT_EMAIL),
        "agent_password": get_secret(AGENT_PASSWORD),
    }

    # Merge: prefer keychain values, fill gaps from credentials.json
    for key in creds:
        if keychain_creds.get(key):
            creds[key] = keychain_creds[key]

    return creds


def clear_agent_credentials() -> None:
    """Remove all agent credentials from the keychain and credentials.json."""
    for account in (
        API_KEY, SLSK_USERNAME, SLSK_PASSWORD, ACOUSTID_KEY,
        SUPABASE_URL, SUPABASE_ANON_KEY, AGENT_EMAIL, AGENT_PASSWORD,
    ):
        delete_secret(account)

    from djtoolkit.agent.paths import config_dir
    creds_file = config_dir() / "credentials.json"
    if creds_file.exists():
        try:
            creds_file.unlink()
        except OSError:
            pass
