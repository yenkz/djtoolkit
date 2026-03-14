"""Cross-platform path resolution for the djtoolkit agent."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def config_dir() -> Path:
    """Return the agent config directory."""
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", str(Path.home()))) / "djtoolkit"
    return Path.home() / ".djtoolkit"


def log_dir() -> Path:
    """Return the agent log directory."""
    if sys.platform == "win32":
        return config_dir() / "logs"
    return Path.home() / "Library" / "Logs" / "djtoolkit"


def default_downloads_dir() -> Path:
    """Return the default downloads directory."""
    return Path.home() / "Music" / "djtoolkit" / "downloads"


def credential_store_name() -> str:
    """Return the human-readable name of the system credential store."""
    if sys.platform == "win32":
        return "Windows Credential Manager"
    return "macOS Keychain"


def service_display_name() -> str:
    """Return the human-readable name for the background service type."""
    if sys.platform == "win32":
        return "service"
    return "LaunchAgent"
