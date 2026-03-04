"""Flow 2 — scan a folder of audio files and import into the DB."""

import sqlite3
from pathlib import Path

from djtoolkit.config import Config
from djtoolkit.db.database import connect
from djtoolkit.fingerprint.chromaprint import calc as calc_fingerprint
from djtoolkit.utils.search_string import build as build_search_string

AUDIO_EXTENSIONS = {".mp3", ".flac", ".aiff", ".aif", ".wav", ".ogg", ".m4a", ".aac"}


def _read_tags(path: Path) -> dict:
    """Extract basic metadata from file tags using mutagen."""
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(str(path), easy=True)
        if audio is None:
            return {}
        def _first(key):
            val = audio.get(key)
            return val[0] if val else None
        return {
            "title":  _first("title"),
            "artist": _first("artist"),
            "album":  _first("album"),
            "year":   int(str(_first("date") or "")[:4]) if _first("date") else None,
            "genres": _first("genre"),
        }
    except Exception:
        return {}


def import_folder(folder: Path, cfg: Config) -> dict:
    """
    Recursively scan folder for audio files, fingerprint each,
    skip duplicates, and insert into tracks with status 'imported'.

    Returns {inserted, skipped_duplicate, skipped_no_audio}.
    """
    if cfg.fingerprint.enabled:
        from djtoolkit.fingerprint.chromaprint import is_available
        if not is_available(cfg):
            raise RuntimeError(
                "fpcalc not found — cannot fingerprint for deduplication. "
                "Install Chromaprint or set fpcalc_path in [fingerprint] in djtoolkit.toml. "
                "To import without fingerprinting set enabled = false."
            )

    from rich.progress import Progress, SpinnerColumn, MofNCompleteColumn, TextColumn, BarColumn

    library_dir = Path(cfg.paths.library_dir).expanduser().resolve()

    stats = {"inserted": 0, "skipped_duplicate": 0, "skipped_no_audio": 0}

    print(f"Scanning {folder} …", flush=True)
    audio_files = [
        p for p in folder.rglob("*")
        if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS
    ]
    print(f"Found {len(audio_files)} audio files", flush=True)

    with connect(cfg.db_path) as conn:
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            MofNCompleteColumn(),
            TextColumn("• inserted: {task.fields[inserted]}  dupes: {task.fields[dupes]}"),
        ) as progress:
            task = progress.add_task(
                "Fingerprinting…", total=len(audio_files), inserted=0, dupes=0
            )

            for path in audio_files:
                progress.update(task, description=f"[dim]{path.name[:50]}[/dim]")

                # Fingerprint first to check duplicates
                fp_data = calc_fingerprint(path, cfg)

                if fp_data:
                    existing = conn.execute(
                        "SELECT track_id FROM fingerprints WHERE fingerprint = ?",
                        (fp_data["fingerprint"],),
                    ).fetchone()
                    if existing:
                        stats["skipped_duplicate"] += 1
                        progress.update(task, advance=1, dupes=stats["skipped_duplicate"])
                        continue

                tags = _read_tags(path)
                artist = tags.get("artist") or path.parent.name
                title = tags.get("title") or path.stem

                in_library = 1 if path.resolve().is_relative_to(library_dir) else 0
                record = {
                    "acquisition_status": "available",
                    "source": "folder",
                    "title": title,
                    "artist": artist,
                    "artists": artist,
                    "album": tags.get("album"),
                    "year": tags.get("year"),
                    "genres": tags.get("genres"),
                    "local_path": str(path),
                    "search_string": build_search_string(artist, title),
                    "in_library": in_library,
                }

                try:
                    columns = ", ".join(record.keys())
                    placeholders = ", ".join("?" for _ in record)
                    cursor = conn.execute(
                        f"INSERT INTO tracks ({columns}) VALUES ({placeholders})",
                        list(record.values()),
                    )
                    track_id = cursor.lastrowid

                    # Store fingerprint if we have it
                    if fp_data:
                        fp_cursor = conn.execute(
                            "INSERT INTO fingerprints (track_id, fingerprint, duration) VALUES (?, ?, ?)",
                            (track_id, fp_data["fingerprint"], fp_data["duration"]),
                        )
                        conn.execute(
                            "UPDATE tracks SET fingerprint_id = ?, fingerprinted = 1 WHERE id = ?",
                            (fp_cursor.lastrowid, track_id),
                        )

                    stats["inserted"] += 1
                except sqlite3.IntegrityError:
                    stats["skipped_duplicate"] += 1

                progress.update(task, advance=1, inserted=stats["inserted"], dupes=stats["skipped_duplicate"])

        conn.commit()

    return stats
