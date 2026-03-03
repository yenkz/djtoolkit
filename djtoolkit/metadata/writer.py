"""Write DB metadata to audio files and normalize filenames."""

import re
import shutil
from pathlib import Path

from mutagen.easyid3 import EasyID3
from mutagen.flac import FLAC
from mutagen.mp4 import MP4
from mutagen import File as MutagenFile

from djtoolkit.config import Config
from djtoolkit.db.database import connect


_UNSAFE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe_name(name: str) -> str:
    return _UNSAFE_CHARS.sub("_", name).strip()


def _target_filename(artist: str, title: str, suffix: str) -> str:
    """Normalize to 'Artist - Title.ext' format."""
    artist = _safe_name(artist or "Unknown Artist")
    title = _safe_name(title or "Unknown Title")
    return f"{artist} - {title}{suffix}"


def _write_tags(path: Path, track: dict) -> bool:
    """Write metadata tags to a file using mutagen. Returns True on success."""
    ext = path.suffix.lower()
    try:
        if ext == ".mp3":
            audio = EasyID3(str(path))
            if track.get("title"):    audio["title"]  = [track["title"]]
            if track.get("artist"):   audio["artist"] = [track["artist"]]
            if track.get("album"):    audio["album"]  = [track["album"]]
            if track.get("year"):     audio["date"]   = [str(track["year"])]
            if track.get("genres"):   audio["genre"]  = [track["genres"].split(",")[0].strip()]
            audio.save()

        elif ext == ".flac":
            audio = FLAC(str(path))
            if track.get("title"):    audio["TITLE"]  = [track["title"]]
            if track.get("artist"):   audio["ARTIST"] = [track["artists"] or track["artist"]]
            if track.get("album"):    audio["ALBUM"]  = [track["album"]]
            if track.get("year"):     audio["DATE"]   = [str(track["year"])]
            if track.get("genres"):   audio["GENRE"]  = [track["genres"].split(",")[0].strip()]
            audio.save()

        elif ext in (".m4a", ".aac"):
            audio = MP4(str(path))
            if track.get("title"):    audio["\xa9nam"] = [track["title"]]
            if track.get("artist"):   audio["\xa9ART"] = [track["artist"]]
            if track.get("album"):    audio["\xa9alb"] = [track["album"]]
            if track.get("year"):     audio["\xa9day"] = [str(track["year"])]
            audio.save()

        else:
            # Generic attempt
            audio = MutagenFile(str(path), easy=True)
            if audio is None:
                return False
            audio.save()

        return True

    except Exception:
        return False


def run(cfg: Config) -> dict:
    """
    Apply DB metadata to all downloaded tracks and normalize filenames.
    Updates status to 'metadata_applied'.

    Returns {applied, failed, skipped}.
    """
    stats = {"applied": 0, "failed": 0, "skipped": 0}

    with connect(cfg.db_path) as conn:
        tracks = conn.execute("""
            SELECT * FROM tracks
            WHERE acquisition_status = 'available'
              AND metadata_written = 0
              AND source = 'exportify'
              AND local_path IS NOT NULL
        """).fetchall()

    for track in tracks:
        track = dict(track)
        local_path = Path(track["local_path"])

        if not local_path.exists():
            stats["skipped"] += 1
            continue

        # Write tags
        if not _write_tags(local_path, track):
            stats["failed"] += 1
            continue

        # Normalize filename: Artist - Title.ext
        new_name = _target_filename(
            track.get("artist") or "",
            track.get("title") or "",
            local_path.suffix,
        )
        new_path = local_path.parent / new_name
        if new_path != local_path:
            # Avoid collision
            if new_path.exists():
                new_path = local_path.parent / (new_path.stem + f"_{track['id']}" + local_path.suffix)
            local_path.rename(new_path)

        with connect(cfg.db_path) as conn:
            conn.execute(
                "UPDATE tracks SET metadata_written = 1, local_path = ? WHERE id = ?",
                (str(new_path), track["id"]),
            )
            conn.commit()
        stats["applied"] += 1

    return stats
