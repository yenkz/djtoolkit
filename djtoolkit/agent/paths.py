"""Cross-platform path resolution for the djtoolkit agent."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _win_known_folder(folder_id: str) -> Path | None:
    """Resolve a Windows Known Folder by GUID via SHGetKnownFolderPath.

    Common GUIDs:
      Music:    {4BD8D571-6D19-48D3-BE97-422220080E43}
      RoamingAppData: {3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}
    """
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes
        _SHGetKnownFolderPath = ctypes.windll.shell32.SHGetKnownFolderPath
        _SHGetKnownFolderPath.argtypes = [
            ctypes.c_char_p, wintypes.DWORD, wintypes.HANDLE,
            ctypes.POINTER(ctypes.c_wchar_p),
        ]
        _SHGetKnownFolderPath.restype = ctypes.HRESULT
        guid = ctypes.create_string_buffer(16)
        ctypes.windll.ole32.CLSIDFromString(folder_id, guid)
        path_ptr = ctypes.c_wchar_p()
        hr = _SHGetKnownFolderPath(guid, 0, None, ctypes.byref(path_ptr))
        if hr == 0 and path_ptr.value:
            result = Path(path_ptr.value)
            ctypes.windll.ole32.CoTaskMemFree(path_ptr)
            return result
    except Exception:
        pass
    return None


def config_dir() -> Path:
    """Return the agent config directory."""
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", str(Path.home()))) / "djtoolkit"
    return Path.home() / ".djtoolkit"


def log_dir() -> Path:
    """Return the agent log directory.

    Logs are written inside the config directory so the tray app's
    log viewer (which reads from ``config_dir() / "agent.log"``) can
    find them without a separate path lookup.
    """
    return config_dir()


def default_downloads_dir() -> Path:
    """Return the default downloads directory."""
    if sys.platform == "win32":
        music = _win_known_folder("{4BD8D571-6D19-48D3-BE97-422220080E43}")
        if music:
            return music / "djtoolkit" / "downloads"
    elif sys.platform == "darwin":
        return Path.home() / "Music" / "djtoolkit" / "downloads"
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
