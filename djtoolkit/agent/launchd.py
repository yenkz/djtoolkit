"""launchd integration — install/uninstall the agent as a macOS LaunchAgent."""

from __future__ import annotations

import os
import platform
import subprocess
import sys
from pathlib import Path

LABEL = "com.djtoolkit.agent"
PLIST_DIR = Path.home() / "Library" / "LaunchAgents"
PLIST_PATH = PLIST_DIR / f"{LABEL}.plist"
LOG_DIR = Path.home() / "Library" / "Logs" / "djtoolkit"


def _gui_domain() -> str:
    """Return the launchctl GUI domain for the current user (e.g. 'gui/501')."""
    return f"gui/{os.getuid()}"


def _bootstrap(plist: Path) -> None:
    """Load a plist using the modern bootstrap API."""
    subprocess.run(
        ["launchctl", "bootstrap", _gui_domain(), str(plist)],
        check=True,
    )


def _bootout(plist: Path) -> None:
    """Unload a service using the modern bootout API."""
    subprocess.run(
        ["launchctl", "bootout", _gui_domain(), str(plist)],
        check=False,  # may already be stopped
    )


def _resolve_binary() -> str:
    """Find the djtoolkit binary path.

    Priority:
    1. Current executable (if frozen via PyInstaller)
    2. Homebrew paths based on architecture
    3. which djtoolkit
    """
    # PyInstaller frozen binary
    if getattr(sys, "frozen", False):
        return sys.executable

    # Homebrew paths
    arch = platform.machine()
    if arch == "arm64":
        brew_path = Path("/opt/homebrew/bin/djtoolkit")
    else:
        brew_path = Path("/usr/local/bin/djtoolkit")
    if brew_path.is_file():
        return str(brew_path)

    # Fallback: which
    import shutil
    found = shutil.which("djtoolkit")
    if found:
        return found

    raise FileNotFoundError(
        "Cannot find djtoolkit binary. "
        "Install via Homebrew or set it on your PATH."
    )


def generate_plist(binary_path: str | None = None) -> str:
    """Generate the launchd plist XML with fully expanded paths."""
    binary = binary_path or _resolve_binary()
    home = str(Path.home())
    log_path = str(LOG_DIR / "agent.log")

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{binary}</string>
        <string>agent</string>
        <string>tray</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{log_path}</string>
    <key>StandardErrorPath</key>
    <string>{log_path}</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>8192</integer>
    </dict>
    <key>HardResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>8192</integer>
    </dict>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>{home}</string>
    </dict>
</dict>
</plist>
"""


def install() -> Path:
    """Write the plist and bootstrap it via launchctl.

    Returns the plist path.
    """
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    PLIST_DIR.mkdir(parents=True, exist_ok=True)

    plist_content = generate_plist()
    PLIST_PATH.write_text(plist_content)

    # Bootout first in case a stale service is registered, then bootstrap
    _bootout(PLIST_PATH)
    _bootstrap(PLIST_PATH)
    return PLIST_PATH


def uninstall() -> None:
    """Unload and remove the plist."""
    if PLIST_PATH.exists():
        _bootout(PLIST_PATH)
        PLIST_PATH.unlink()


def start() -> None:
    """Bootstrap a previously installed agent (idempotent)."""
    if not PLIST_PATH.exists():
        raise FileNotFoundError(
            "Agent not installed. Run 'djtoolkit agent install' first."
        )
    if is_running():
        return
    _bootstrap(PLIST_PATH)


def stop() -> None:
    """Bootout the agent. It will restart on next login (KeepAlive plist)."""
    if not PLIST_PATH.exists():
        raise FileNotFoundError(
            "Agent not installed. Run 'djtoolkit agent install' first."
        )
    _bootout(PLIST_PATH)


def is_installed() -> bool:
    """Check if the plist file exists."""
    return PLIST_PATH.exists()


def is_running() -> bool:
    """Check if the agent is currently loaded in launchctl."""
    result = subprocess.run(
        ["launchctl", "print", f"{_gui_domain()}/{LABEL}"],
        capture_output=True,
    )
    return result.returncode == 0
