"""Write DB metadata to audio files and normalize filenames."""

import re
from pathlib import Path

from mutagen.easyid3 import EasyID3
from mutagen.flac import FLAC
from mutagen.mp4 import MP4
from mutagen import File as MutagenFile
from rich.progress import (
    Progress, SpinnerColumn, BarColumn, TextColumn,
    MofNCompleteColumn, TimeElapsedColumn,
)

from djtoolkit.config import Config
from djtoolkit.db.database import connect

# Register TKEY (initial key) — not in EasyID3 defaults
EasyID3.RegisterTextKey("initialkey", "TKEY")

_UNSAFE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

_KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _safe_name(name: str) -> str:
    return _UNSAFE_CHARS.sub("_", name).strip()


def _target_filename(artist: str, title: str, suffix: str) -> str:
    """Normalize to 'Artist - Title.ext' format."""
    artist = _safe_name(artist or "Unknown Artist")
    title = _safe_name(title or "Unknown Title")
    return f"{artist} - {title}{suffix}"


def _key_str(key: int, mode: int) -> str:
    """Return key in standard notation, e.g. 'Am', 'F#', 'C'."""
    return _KEY_NAMES[key % 12] + ("" if mode else "m")


def _write_tags(path: Path, track: dict) -> bool:
    """Write metadata tags to a file using mutagen. Returns True on success."""
    ext = path.suffix.lower()
    try:
        if ext == ".mp3":
            audio = EasyID3(str(path))
            if track.get("title"):    audio["title"]      = [track["title"]]
            if track.get("artist"):   audio["artist"]     = [track["artist"]]
            if track.get("album"):    audio["album"]      = [track["album"]]
            if track.get("year"):     audio["date"]       = [str(track["year"])]
            if track.get("genres"):   audio["genre"]      = [track["genres"].split(",")[0].strip()]
            if track.get("tempo"):    audio["bpm"]        = [str(int(round(track["tempo"])))]
            if track.get("key") is not None and track.get("mode") is not None:
                audio["initialkey"] = [_key_str(track["key"], track["mode"])]
            audio.save()

        elif ext == ".flac":
            audio = FLAC(str(path))
            if track.get("title"):    audio["TITLE"]      = [track["title"]]
            if track.get("artist"):   audio["ARTIST"]     = [track["artists"] or track["artist"]]
            if track.get("album"):    audio["ALBUM"]      = [track["album"]]
            if track.get("year"):     audio["DATE"]       = [str(track["year"])]
            if track.get("genres"):   audio["GENRE"]      = [track["genres"].split(",")[0].strip()]
            if track.get("tempo"):    audio["BPM"]        = [str(int(round(track["tempo"])))]
            if track.get("key") is not None and track.get("mode") is not None:
                audio["INITIALKEY"] = [_key_str(track["key"], track["mode"])]
            audio.save()

        elif ext in (".m4a", ".aac"):
            from mutagen.mp4 import MP4FreeForm, AtomDataType
            audio = MP4(str(path))
            if track.get("title"):    audio["\xa9nam"]    = [track["title"]]
            if track.get("artist"):   audio["\xa9ART"]    = [track["artist"]]
            if track.get("album"):    audio["\xa9alb"]    = [track["album"]]
            if track.get("year"):     audio["\xa9day"]    = [str(track["year"])]
            if track.get("tempo"):    audio["tmpo"]       = [int(round(track["tempo"]))]
            if track.get("key") is not None and track.get("mode") is not None:
                audio["----:com.apple.iTunes:initialkey"] = [
                    MP4FreeForm(_key_str(track["key"], track["mode"]).encode(), AtomDataType.UTF8)
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


def run(cfg: Config, metadata_source: str | None = None, csv_path: Path | None = None) -> dict:
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
            enrich_stats = spotify_run(csv_path, cfg, force=True)
            matched_ids = enrich_stats["matched_ids"]
            progress.update(
                enrich_task,
                description=f"[green]Spotify enrichment done ({enrich_stats['matched']} matched)",
                total=1, completed=1,
            )

        elif metadata_source == "audio-analysis":
            enrich_task = progress.add_task("Running audio analysis…", total=None)
            from djtoolkit.enrichment.audio_analysis import run as audio_run
            audio_run(cfg)
            progress.update(enrich_task, description="[green]Audio analysis done", total=1, completed=1)

        # Step 2 — Query tracks eligible for writing
        with connect(cfg.db_path) as conn:
            if metadata_source == "spotify":
                if not matched_ids:
                    tracks = []
                else:
                    placeholders = ",".join("?" * len(matched_ids))
                    tracks = conn.execute(
                        f"SELECT * FROM tracks WHERE id IN ({placeholders}) AND local_path IS NOT NULL",
                        matched_ids,
                    ).fetchall()
            elif metadata_source == "audio-analysis":
                tracks = conn.execute("""
                    SELECT * FROM tracks
                    WHERE acquisition_status = 'available'
                      AND enriched_audio = 1
                      AND local_path IS NOT NULL
                """).fetchall()
            else:
                tracks = conn.execute("""
                    SELECT * FROM tracks
                    WHERE acquisition_status = 'available'
                      AND metadata_written = 0
                      AND local_path IS NOT NULL
                """).fetchall()

        # Step 3 — Write tags and normalize filenames
        total = len(tracks)
        write_task = progress.add_task(f"Writing tags… (0/{total})", total=total)
        for track in tracks:
            track = dict(track)
            local_path = Path(track["local_path"])

            artist = track.get("artist") or ""
            title = track.get("title") or ""
            n = stats["applied"] + stats["failed"] + stats["skipped"] + 1
            progress.update(write_task, description=f"[dim]({n}/{total}) {artist} — {title}"[:72])

            # Already tagged with this source — skip (idempotent re-runs)
            if (
                metadata_source is not None
                and track.get("metadata_written") == 1
                and track.get("metadata_source") == metadata_source
            ):
                stats["skipped"] += 1
                progress.advance(write_task)
                continue

            if not local_path.exists():
                stats["skipped"] += 1
                progress.advance(write_task)
                continue

            if not _write_tags(local_path, track):
                stats["failed"] += 1
                progress.advance(write_task)
                continue

            # Normalize filename: Artist - Title.ext
            new_name = _target_filename(artist, title, local_path.suffix)
            new_path = local_path.parent / new_name
            if new_path != local_path:
                if new_path.exists():
                    new_path = local_path.parent / (new_path.stem + f"_{track['id']}" + local_path.suffix)
                local_path.rename(new_path)
            else:
                new_path = local_path

            # Step 4 — Update DB
            with connect(cfg.db_path) as conn:
                conn.execute(
                    "UPDATE tracks SET metadata_written = 1, metadata_source = ?, local_path = ? WHERE id = ?",
                    (metadata_source, str(new_path), track["id"]),
                )
                conn.commit()
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
