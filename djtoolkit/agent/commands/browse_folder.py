# djtoolkit/agent/commands/browse_folder.py
"""Agent command: browse a local directory and return its contents."""

from __future__ import annotations

from pathlib import Path

from djtoolkit.importers.folder import AUDIO_EXTENSIONS


def browse_folder(payload: dict) -> dict:
    """List directory contents filtered to audio files and subdirectories.

    Args:
        payload: {"path": "/some/dir"} or {} for home directory.

    Returns:
        {"path": str, "parent": str|None, "entries": [{name, type, size_bytes, extension}]}
    """
    raw_path = payload.get("path")
    path = Path(raw_path).expanduser().resolve() if raw_path else Path.home()

    if not path.is_dir():
        raise ValueError(f"Not a directory: {path}")

    entries: list[dict] = []
    try:
        for item in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            if item.name.startswith("."):
                continue

            if item.is_dir():
                entries.append({
                    "name": item.name,
                    "type": "dir",
                    "size_bytes": None,
                    "extension": None,
                })
            elif item.is_file() and item.suffix.lower() in AUDIO_EXTENSIONS:
                entries.append({
                    "name": item.name,
                    "type": "file",
                    "size_bytes": item.stat().st_size,
                    "extension": item.suffix.lower(),
                })
    except PermissionError:
        raise ValueError(f"Permission denied: {path}")

    return {
        "path": str(path),
        "entries": entries,
        "parent": str(path.parent) if path != path.parent else None,
    }
