"""Write DB metadata to audio files and normalize filenames."""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING

from mutagen.easyid3 import EasyID3
from mutagen.flac import FLAC
from mutagen.mp4 import MP4
from mutagen import File as MutagenFile
from rich.progress import (
    Progress, SpinnerColumn, BarColumn, TextColumn,
    MofNCompleteColumn, TimeElapsedColumn,
)

from djtoolkit.config import Config

if TYPE_CHECKING:
    from djtoolkit.adapters.supabase import SupabaseAdapter

# Register TKEY (initial key) — not in EasyID3 defaults
EasyID3.RegisterTextKey("initialkey", "TKEY")

_UNSAFE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe_name(name: str) -> str:
    return _UNSAFE_CHARS.sub("_", name).strip()


def _target_filename(artist: str, title: str, suffix: str) -> str:
    """Normalize to 'Artist - Title.ext' format."""
    artist = _safe_name(artist or "Unknown Artist")
    title = _safe_name(title or "Unknown Title")
    return f"{artist} - {title}{suffix}"


_KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _key_tag_str(key_normalized: str) -> str | None:
    """Convert normalized key (e.g. 'C minor', 'F# major') to tag format ('Cm', 'F#').

    Returns None if key is empty or unparseable.
    """
    if not key_normalized:
        return None
    parts = key_normalized.split()
    if len(parts) != 2:
        return None
    note, scale = parts[0], parts[1].lower()
    if scale == "minor":
        return f"{note}m"
    elif scale == "major":
        return note
    return None


def _resolve_key_tag(track: dict) -> str | None:
    """Resolve the key tag string from a track dict.

    Handles two formats:
      - New: key is a normalized string like 'C minor', 'F# major'
      - Legacy: key is an integer (0-11) with a separate 'mode' integer (0/1)
    """
    raw_key = track.get("key")
    if raw_key is None:
        return None
    if isinstance(raw_key, str):
        return _key_tag_str(raw_key)
    # Legacy integer format
    if isinstance(raw_key, int) and track.get("mode") is not None:
        return _KEY_NAMES[raw_key % 12] + ("" if track["mode"] else "m")
    return None


def _write_tags(path: Path, track: dict) -> bool:
    """Write metadata tags to a file using mutagen. Returns True on success."""
    ext = path.suffix.lower()
    try:
        key_tag = _resolve_key_tag(track)

        if ext == ".mp3":
            audio = EasyID3(str(path))
            if track.get("title"):    audio["title"]      = [track["title"]]
            if track.get("artist"):   audio["artist"]     = [track["artist"]]
            if track.get("album"):    audio["album"]      = [track["album"]]
            if track.get("year"):     audio["date"]       = [str(track["year"])]
            if track.get("genres"):   audio["genre"]      = [track["genres"].split(",")[0].strip()]
            if track.get("tempo"):    audio["bpm"]        = [str(int(round(track["tempo"])))]
            if key_tag:
                audio["initialkey"] = [key_tag]
            audio.save()

        elif ext == ".flac":
            audio = FLAC(str(path))
            if track.get("title"):    audio["TITLE"]      = [track["title"]]
            if track.get("artist"):   audio["ARTIST"]     = [track["artists"] or track["artist"]]
            if track.get("album"):    audio["ALBUM"]      = [track["album"]]
            if track.get("year"):     audio["DATE"]       = [str(track["year"])]
            if track.get("genres"):   audio["GENRE"]      = [track["genres"].split(",")[0].strip()]
            if track.get("tempo"):    audio["BPM"]        = [str(int(round(track["tempo"])))]
            if key_tag:
                audio["INITIALKEY"] = [key_tag]
            audio.save()

        elif ext in (".m4a", ".aac"):
            from mutagen.mp4 import MP4FreeForm, AtomDataType
            audio = MP4(str(path))
            if track.get("title"):    audio["\xa9nam"]    = [track["title"]]
            if track.get("artist"):   audio["\xa9ART"]    = [track["artist"]]
            if track.get("album"):    audio["\xa9alb"]    = [track["album"]]
            if track.get("year"):     audio["\xa9day"]    = [str(track["year"])]
            if track.get("tempo"):    audio["tmpo"]       = [int(round(track["tempo"]))]
            if key_tag:
                audio["----:com.apple.iTunes:initialkey"] = [
                    MP4FreeForm(key_tag.encode(), AtomDataType.UTF8)
                ]
            audio.save()

        else:
            audio = MutagenFile(str(path), easy=True)
            if audio is None:
                return False
            audio.save()

        return True

    except Exception:
        return False


def run(cfg: Config, adapter: "SupabaseAdapter", user_id: str,
        metadata_source: str | None = None, csv_path: Path | None = None) -> dict:
    """
    Apply DB metadata to tracks and normalize filenames.

    metadata_source:
      None             — process only unwritten tracks (metadata_written=0), any track source
      'spotify'        — run Exportify enrichment (force-overwrite), then write all matched tracks
      'audio-analysis' — run audio analysis, then write all tracks with enriched_audio=1

    When metadata_source is set, already-written tracks are re-processed so the chosen source
    always wins for overlapping fields.

    Returns {applied, failed, skipped}.
    """
    stats = {"applied": 0, "failed": 0, "skipped": 0}

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
    ) as progress:

        # Step 1 — Run enrichment inline so DB reflects the chosen source before writing files
        matched_ids: list[int] = []
        if metadata_source == "spotify":
            enrich_task = progress.add_task("Enriching from Spotify CSV…", total=None)
            from djtoolkit.enrichment.spotify import run as spotify_run
            enrich_stats = spotify_run(csv_path, cfg, adapter, user_id, force=True)
            matched_ids = enrich_stats["matched_ids"]
            progress.update(
                enrich_task,
                description=f"[green]Spotify enrichment done ({enrich_stats['matched']} matched)",
                total=1, completed=1,
            )

        elif metadata_source == "audio-analysis":
            enrich_task = progress.add_task("Running audio analysis…", total=None)
            from djtoolkit.enrichment.audio_analysis import run as audio_run
            audio_run(cfg, adapter, user_id)
            progress.update(enrich_task, description="[green]Audio analysis done", total=1, completed=1)

        # Step 2 — Query tracks eligible for writing
        if metadata_source == "spotify":
            tracks = adapter.query_tracks_by_ids(matched_ids, user_id) if matched_ids else []
        elif metadata_source == "audio-analysis":
            tracks = adapter.query_enriched_audio_tracks(user_id)
        else:
            tracks = adapter.query_unwritten_metadata(user_id)

        # Step 3 — Write tags and normalize filenames
        total = len(tracks)
        write_task = progress.add_task(f"Writing tags… (0/{total})", total=total)
        for track in tracks:
            local_path = Path(track.file_path) if track.file_path else None

            artist = track.artist or ""
            title = track.title or ""
            n = stats["applied"] + stats["failed"] + stats["skipped"] + 1
            progress.update(write_task, description=f"[dim]({n}/{total}) {artist} — {title}"[:72])

            if not local_path or not local_path.exists():
                stats["skipped"] += 1
                progress.advance(write_task)
                continue

            # Build tag dict from Track object
            tag_dict = {
                "title": track.title,
                "artist": track.artist,
                "album": track.album,
                "year": track.year,
                "genres": track.genres,
                "artists": "|".join(track.artists) if track.artists else track.artist,
                "tempo": track.bpm or track.tempo,
                "key": track.key,
            }

            if not _write_tags(local_path, tag_dict):
                stats["failed"] += 1
                progress.advance(write_task)
                continue

            # Normalize filename: Artist - Title.ext
            new_name = _target_filename(artist, title, local_path.suffix)
            new_path = local_path.parent / new_name
            if new_path != local_path:
                if new_path.exists():
                    new_path = local_path.parent / (new_path.stem + f"_{track._id}" + local_path.suffix)
                local_path.rename(new_path)
            else:
                new_path = local_path

            # Step 4 — Update DB
            adapter.update_track(track._id, {
                "metadata_written": True,
                "metadata_source": metadata_source,
                "local_path": str(new_path),
            })
            stats["applied"] += 1
            progress.advance(write_task)

        progress.update(
            write_task,
            description=(
                f"[green]Done — {stats['applied']} applied"
                + (f", {stats['failed']} failed" if stats["failed"] else "")
                + (f", {stats['skipped']} skipped" if stats["skipped"] else "")
            ),
        )

    return stats
