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
        <string>run</string>
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
    """Write the plist and load it via launchctl.

    Returns the plist path.
    """
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    PLIST_DIR.mkdir(parents=True, exist_ok=True)

    plist_content = generate_plist()
    PLIST_PATH.write_text(plist_content)

    # Load the agent
    subprocess.run(
        ["launchctl", "load", str(PLIST_PATH)],
        check=True,
    )
    return PLIST_PATH


def uninstall() -> None:
    """Unload and remove the plist."""
    if PLIST_PATH.exists():
        subprocess.run(
            ["launchctl", "unload", str(PLIST_PATH)],
            check=False,  # may already be unloaded
        )
        PLIST_PATH.unlink()


def start() -> None:
    """Load (resume) a previously installed agent."""
    if not PLIST_PATH.exists():
        raise FileNotFoundError(
            "Agent not installed. Run 'djtoolkit agent install' first."
        )
    subprocess.run(["launchctl", "load", str(PLIST_PATH)], check=True)


def stop() -> None:
    """Unload (temporarily stop) the agent. Resumes on next boot."""
    if not PLIST_PATH.exists():
        raise FileNotFoundError(
            "Agent not installed. Run 'djtoolkit agent install' first."
        )
    subprocess.run(["launchctl", "unload", str(PLIST_PATH)], check=True)


def is_installed() -> bool:
    """Check if the plist file exists."""
    return PLIST_PATH.exists()


def is_running() -> bool:
    """Check if the agent is currently loaded in launchctl."""
    if not PLIST_PATH.exists():
        return False
    result = subprocess.run(
        ["launchctl", "list", LABEL],
        capture_output=True, text=True,
    )
    return result.returncode == 0
