"""Agent command: recursively scan a folder and return all audio files."""

from __future__ import annotations

from pathlib import Path

from djtoolkit.importers.folder import AUDIO_EXTENSIONS


def scan_folder(payload: dict) -> dict:
    """Recursively list all audio files in a directory.

    Args:
        payload: {"path": "/some/dir", "recursive": true}

    Returns:
        {"path": str, "files": [{name, size_bytes, extension, rel_path}], "total_count": int}
    """
    raw_path = payload.get("path")
    if not raw_path:
        raise ValueError("path is required")

    path = Path(raw_path).expanduser().resolve()
    if not path.is_dir():
        raise ValueError(f"Not a directory: {path}")

    recursive = payload.get("recursive", True)
    pattern = path.rglob("*") if recursive else path.iterdir()

    files: list[dict] = []
    try:
        for item in sorted(pattern, key=lambda p: p.name.lower()):
            if item.name.startswith("."):
                continue
            if item.is_file() and item.suffix.lower() in AUDIO_EXTENSIONS:
                try:
                    rel = item.relative_to(path)
                except ValueError:
                    rel = item.name
                files.append({
                    "name": item.name,
                    "size_bytes": item.stat().st_size,
                    "extension": item.suffix.lower(),
                    "rel_path": str(rel),
                })
    except PermissionError:
        raise ValueError(f"Permission denied: {path}")

    return {
        "path": str(path),
        "files": files,
        "total_count": len(files),
    }
