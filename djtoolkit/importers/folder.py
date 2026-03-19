"""Flow 2 -- scan a folder of audio files and import into the DB."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from djtoolkit.config import Config
from djtoolkit.fingerprint.chromaprint import calc as calc_fingerprint
from djtoolkit.models.track import Track
from djtoolkit.utils.search_string import build as build_search_string

if TYPE_CHECKING:
    from djtoolkit.adapters.supabase import SupabaseAdapter

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


def import_folder(folder: Path, cfg: Config, adapter: "SupabaseAdapter", user_id: str) -> dict:
    """
    Recursively scan folder for audio files, fingerprint each,
    skip duplicates, and insert into tracks with status 'available'.

    Returns {inserted, skipped_duplicate, skipped_no_audio}.
    """
    if cfg.fingerprint.enabled:
        from djtoolkit.fingerprint.chromaprint import is_available
        if not is_available(cfg):
            raise RuntimeError(
                "fpcalc not found -- cannot fingerprint for deduplication. "
                "Install Chromaprint or set fpcalc_path in [fingerprint] in djtoolkit.toml. "
                "To import without fingerprinting set enabled = false."
            )

    from rich.progress import Progress, SpinnerColumn, MofNCompleteColumn, TextColumn, BarColumn

    library_dir = Path(cfg.paths.library_dir).expanduser().resolve()

    stats = {"inserted": 0, "skipped_duplicate": 0, "skipped_no_audio": 0}

    print(f"Scanning {folder} ...", flush=True)
    audio_files = [
        p for p in folder.rglob("*")
        if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS
    ]
    print(f"Found {len(audio_files)} audio files", flush=True)

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TextColumn("* inserted: {task.fields[inserted]}  dupes: {task.fields[dupes]}"),
    ) as progress:
        task = progress.add_task(
            "Fingerprinting...", total=len(audio_files), inserted=0, dupes=0
        )

        for path in audio_files:
            progress.update(task, description=f"[dim]{path.name[:50]}[/dim]")

            # Fingerprint first to check duplicates
            fp_data = calc_fingerprint(path, cfg)

            if fp_data:
                existing = adapter.find_fingerprint_match(fp_data["fingerprint"], user_id)
                if existing:
                    stats["skipped_duplicate"] += 1
                    progress.update(task, advance=1, dupes=stats["skipped_duplicate"])
                    continue

            tags = _read_tags(path)
            artist = tags.get("artist") or path.parent.name
            title = tags.get("title") or path.stem

            track_obj = Track(
                title=title,
                artist=artist,
                artists=[artist],
                album=tags.get("album") or "",
                year=tags.get("year"),
                genres=tags.get("genres") or "",
                file_path=str(path),
                source="folder",
            )
            # Set source_id to the file path to prevent duplicate imports
            track_obj.source_id = str(path)

            result = adapter.save_tracks([track_obj], user_id)
            if not result["track_ids"]:
                stats["skipped_duplicate"] += 1
                progress.update(task, advance=1, dupes=stats["skipped_duplicate"])
                continue
            track_id = result["track_ids"][0]

            # Set acquisition_status and other fields not covered by to_db_row()
            in_library = path.resolve().is_relative_to(library_dir)
            adapter.update_track(track_id, {
                "acquisition_status": "available",
                "in_library": bool(in_library),
                "search_string": build_search_string(artist, title),
            })

            # Store fingerprint if we have it
            if fp_data:
                fp_id = adapter.insert_fingerprint(
                    user_id=user_id,
                    track_id=track_id,
                    fingerprint=fp_data["fingerprint"],
                    acoustid=None,
                    duration=fp_data["duration"],
                )
                adapter.mark_fingerprinted(track_id, {"fingerprint_id": fp_id})

            stats["inserted"] += 1
            progress.update(task, advance=1, inserted=stats["inserted"], dupes=stats["skipped_duplicate"])

    return stats
