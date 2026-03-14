"""Platform dispatcher for agent service management."""
from __future__ import annotations

import sys
from types import ModuleType


def get_service_manager() -> ModuleType:
    """Return the platform-specific service manager module.

    Returns a module exposing: install(), uninstall(), start(), stop(),
    is_installed(), is_running().
    """
    if sys.platform == "darwin":
        from djtoolkit.agent import launchd
        return launchd
    elif sys.platform == "win32":
        from djtoolkit.agent import windows_service
        return windows_service
    else:
        raise RuntimeError(f"Unsupported platform: {sys.platform}")
