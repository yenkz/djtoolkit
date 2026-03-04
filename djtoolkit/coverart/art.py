"""djtoolkit.coverart.art
=======================

Fetch album cover art from online sources and embed it into audio files.

Sources (tried in order as configured in ``[cover_art] sources``):

  coverart  — Cover Art Archive (MusicBrainz) — free, no auth. Searches release-group by
              artist+album, then falls back to recording search by artist+title (better for singles)
  itunes    — iTunes Search API — free, returns up to 3000×3000 images (album-based)
  deezer    — Deezer Search API — free, no auth. Searches by artist+title → good for singles
  spotify   — Spotify API — exact match via ``spotify_uri`` from DB (Exportify tracks only).
              Requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET in .env
  lastfm    — Last.fm album.getinfo — album-based. Requires LASTFM_API_KEY in .env or config

Embedding:

  .flac  — mutagen.flac PICTURE block, type 3 (Cover Front)
  .mp3   — mutagen.id3 APIC frame, type 3 (Cover Front)
  .m4a   — mutagen.mp4 ``covr`` atom

Config (``[cover_art]`` in djtoolkit.toml)::

  force          = false                 # re-embed even if art already present
  skip_embed     = false                 # dry-run: fetch only, don't write to file
  sources        = "coverart itunes deezer"  # space-separated, tried in order
  minwidth       = 800                   # reject images narrower than this (px)
  maxwidth       = 2000                  # resize images wider than this (px, requires Pillow)
  quality        = 90                    # JPEG quality when re-encoding after resize
  lastfm_api_key = ""                    # or set LASTFM_API_KEY in .env
"""

import io
import json
import logging
import struct
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

from rich.console import Console
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
)

from djtoolkit.config import Config
from djtoolkit.db.database import connect

log = logging.getLogger(__name__)
console = Console()

_EMBEDDABLE_EXTS = {".mp3", ".flac", ".m4a", ".aac"}
_USER_AGENT = "djtoolkit/1.0 (cover art fetcher)"


# ─── Detection ────────────────────────────────────────────────────────────────

def _has_cover_art(path: Path) -> bool:
    """Return True if the file already has embedded cover art."""
    ext = path.suffix.lower()
    try:
        if ext == ".flac":
            from mutagen.flac import FLAC
            return len(FLAC(path).pictures) > 0
        elif ext == ".mp3":
            from mutagen.id3 import ID3, ID3NoHeaderError
            try:
                tags = ID3(path)
            except ID3NoHeaderError:
                return False
            return any(k.startswith("APIC") for k in tags.keys())
        elif ext in (".m4a", ".aac"):
            from mutagen.mp4 import MP4
            audio = MP4(path)
            return bool(audio.tags and "covr" in audio.tags)
    except Exception:
        pass
    return False


# ─── Image utilities ──────────────────────────────────────────────────────────

def _image_dimensions(data: bytes) -> tuple[int, int]:
    """Return (width, height) from raw JPEG or PNG bytes without Pillow.

    Raises ValueError if the format is unrecognised.
    """
    if data[:3] == b"\xff\xd8\xff":
        # JPEG — walk segments to find SOF0/SOF1/SOF2 marker
        i = 2
        while i < len(data) - 8:
            marker = struct.unpack(">H", data[i : i + 2])[0]
            length = struct.unpack(">H", data[i + 2 : i + 4])[0]
            if marker in (0xFFC0, 0xFFC1, 0xFFC2):
                h = struct.unpack(">H", data[i + 5 : i + 7])[0]
                w = struct.unpack(">H", data[i + 7 : i + 9])[0]
                return w, h
            i += 2 + length
    elif data[:8] == b"\x89PNG\r\n\x1a\n":
        # PNG IHDR is always the first chunk, starting at byte 16
        w = struct.unpack(">I", data[16:20])[0]
        h = struct.unpack(">I", data[20:24])[0]
        return w, h
    raise ValueError("unrecognised image format")


def _mime_type(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "image/jpeg"


def _resize_to_maxwidth(data: bytes, maxwidth: int, quality: int = 90) -> bytes:
    """Downscale image so its width ≤ maxwidth.

    Requires Pillow. Returns original bytes unchanged if Pillow is not installed.
    """
    try:
        from PIL import Image
    except ImportError:
        log.debug("Pillow not installed — maxwidth resize skipped (pip install Pillow)")
        return data
    img = Image.open(io.BytesIO(data))
    if img.width <= maxwidth:
        return data
    ratio = maxwidth / img.width
    new_size = (maxwidth, int(img.height * ratio))
    img = img.resize(new_size, Image.LANCZOS)
    buf = io.BytesIO()
    fmt = "PNG" if _mime_type(data) == "image/png" else "JPEG"
    save_kwargs: dict = {"format": fmt}
    if fmt == "JPEG":
        save_kwargs["quality"] = quality
    img.save(buf, **save_kwargs)
    return buf.getvalue()


# ─── HTTP helpers ─────────────────────────────────────────────────────────────

def _http_get_bytes(url: str, timeout: int = 15) -> Optional[bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except Exception as exc:
        log.debug("HTTP GET %s → %s", url, exc)
        return None


def _http_get_json(url: str, timeout: int = 10) -> Optional[dict]:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except Exception as exc:
        log.debug("HTTP GET JSON %s → %s", url, exc)
        return None


# ─── Art sources ──────────────────────────────────────────────────────────────

def _source_coverart_recording(artist: str, title: str) -> Optional[bytes]:
    """MusicBrainz recording search — better than release-group search for singles."""
    query = urllib.parse.quote(f'artist:"{artist}" AND recording:"{title}"')
    data = _http_get_json(
        f"https://musicbrainz.org/ws/2/recording/?query={query}&fmt=json&limit=3"
    )
    if not data:
        return None
    for recording in data.get("recordings", []):
        for release in recording.get("releases", [])[:2]:
            rg_id = release.get("release-group", {}).get("id")
            r_id = release.get("id")
            for mbid, url in [
                (rg_id, f"https://coverartarchive.org/release-group/{rg_id}/front-1200"),
                (r_id,  f"https://coverartarchive.org/release/{r_id}/front-500"),
            ]:
                if mbid:
                    img = _http_get_bytes(url)
                    if img:
                        return img
    return None


def _source_coverart(artist: str, album: str, title: str = "") -> Optional[bytes]:
    """Cover Art Archive via MusicBrainz release-group search.

    Falls back to recording search by track title when release-group search finds nothing
    (more reliable for singles and EPs where the album name is obscure or missing).
    """
    query = urllib.parse.quote(f'artist:"{artist}" AND release:"{album}"')
    mb_url = f"https://musicbrainz.org/ws/2/release-group/?query={query}&fmt=json&limit=3"
    data = _http_get_json(mb_url)
    if data:
        groups = data.get("release-groups", [])
        if groups:
            mbid = groups[0].get("id")
            if mbid:
                for size in ("1200", "500"):
                    img = _http_get_bytes(
                        f"https://coverartarchive.org/release-group/{mbid}/front-{size}"
                    )
                    if img:
                        return img
    # Fallback: recording search by track title (catches singles not in release-groups)
    if title and title != album:
        time.sleep(0.3)
        return _source_coverart_recording(artist, title)
    return None


def _source_itunes(artist: str, album: str) -> Optional[bytes]:
    """iTunes Search API — scales artwork URL up to 3000×3000."""
    query = urllib.parse.quote(f"{artist} {album}")
    data = _http_get_json(
        f"https://itunes.apple.com/search?term={query}&entity=album&limit=5"
    )
    if not data or not data.get("results"):
        return None
    art_url = data["results"][0].get("artworkUrl100")
    if not art_url:
        return None
    art_url = art_url.replace("100x100bb", "3000x3000bb")
    return _http_get_bytes(art_url)


def _source_deezer(artist: str, title: str) -> Optional[bytes]:
    """Deezer Search API — free, no auth. Searches by track title (great for singles)."""
    query = urllib.parse.quote(f"{artist} {title}")
    data = _http_get_json(f"https://api.deezer.com/search?q={query}&limit=5")
    if not data or not data.get("data"):
        return None
    for result in data["data"]:
        url = result.get("album", {}).get("cover_xl")
        if url:
            return _http_get_bytes(url)
    return None


def _source_spotify(spotify_uri: str, client_id: str, client_secret: str) -> Optional[bytes]:
    """Direct Spotify track lookup — exact match via URI.

    Uses the Spotify Web API ``/tracks/{id}`` endpoint (Client Credentials flow).
    Picks the largest image from ``album.images``.
    Requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET in .env.
    """
    if not client_id or not client_secret:
        log.debug("Spotify source skipped — SPOTIFY_CLIENT_ID/SECRET not set")
        return None
    try:
        import spotipy
        from spotipy.oauth2 import SpotifyClientCredentials
        sp = spotipy.Spotify(
            auth_manager=SpotifyClientCredentials(
                client_id=client_id,
                client_secret=client_secret,
            )
        )
        track = sp.track(spotify_uri)
        images = track.get("album", {}).get("images", [])
        if not images:
            return None
        best = max(images, key=lambda x: x.get("width", 0))
        return _http_get_bytes(best["url"])
    except Exception as exc:
        log.debug("Spotify source failed: %s", exc)
        return None


def _source_lastfm(artist: str, album: str, api_key: str) -> Optional[bytes]:
    """Last.fm album.getinfo — requires LASTFM_API_KEY."""
    url = (
        "http://ws.audioscrobbler.com/2.0/"
        f"?method=album.getinfo&artist={urllib.parse.quote(artist)}"
        f"&album={urllib.parse.quote(album)}&api_key={api_key}&format=json"
    )
    data = _http_get_json(url)
    if not data or "album" not in data:
        return None
    for size in ("mega", "extralarge", "large"):
        for img in data["album"].get("image", []):
            if img.get("size") == size and img.get("#text"):
                return _http_get_bytes(img["#text"])
    return None


def _fetch_art(
    artist: str,
    album: str,
    title: str,
    sources: list[str],
    *,
    spotify_uri: Optional[str] = None,
    spotify_client_id: str = "",
    spotify_client_secret: str = "",
    lastfm_api_key: str = "",
) -> Optional[bytes]:
    """Try each configured source in order. Returns the first successful image."""
    for source in sources:
        try:
            if source == "coverart":
                img = _source_coverart(artist, album, title)
            elif source == "itunes":
                img = _source_itunes(artist, album)
            elif source == "deezer":
                img = _source_deezer(artist, title)
            elif source == "spotify":
                img = _source_spotify(spotify_uri, spotify_client_id, spotify_client_secret) if spotify_uri else None
            elif source == "lastfm":
                img = _source_lastfm(artist, album, lastfm_api_key) if lastfm_api_key else None
            else:
                log.debug("unknown cover art source %r — skipping", source)
                continue
        except Exception as exc:
            log.debug("source %r raised: %s", source, exc)
            img = None
        if img:
            log.debug("fetched art from %r (%d bytes)", source, len(img))
            return img
        time.sleep(0.3)  # polite delay between source attempts
    return None


# ─── Embedding ────────────────────────────────────────────────────────────────

def _embed_flac(path: Path, data: bytes, mime: str) -> None:
    from mutagen.flac import FLAC, Picture
    audio = FLAC(path)
    pic = Picture()
    pic.type = 3  # 3 = Cover (front)
    pic.mime = mime
    pic.desc = "Cover"
    pic.data = data
    audio.clear_pictures()
    audio.add_picture(pic)
    audio.save()


def _embed_mp3(path: Path, data: bytes, mime: str) -> None:
    from mutagen.id3 import ID3, APIC, ID3NoHeaderError
    try:
        tags = ID3(path)
    except ID3NoHeaderError:
        tags = ID3()
    for key in [k for k in tags.keys() if k.startswith("APIC")]:
        del tags[key]
    tags["APIC:Cover"] = APIC(
        encoding=3,   # UTF-8
        mime=mime,
        type=3,       # Front cover
        desc="Cover",
        data=data,
    )
    tags.save(path)


def _embed_m4a(path: Path, data: bytes, mime: str) -> None:
    from mutagen.mp4 import MP4, MP4Cover
    audio = MP4(path)
    if audio.tags is None:
        audio.add_tags()
    fmt = MP4Cover.FORMAT_JPEG if "jpeg" in mime else MP4Cover.FORMAT_PNG
    audio.tags["covr"] = [MP4Cover(data, imageformat=fmt)]
    audio.save()


def _embed(path: Path, data: bytes) -> None:
    """Embed image bytes into the audio file based on its extension."""
    mime = _mime_type(data)
    ext = path.suffix.lower()
    if ext == ".flac":
        _embed_flac(path, data, mime)
    elif ext == ".mp3":
        _embed_mp3(path, data, mime)
    elif ext in (".m4a", ".aac"):
        _embed_m4a(path, data, mime)
    else:
        raise ValueError(f"unsupported format for cover art embedding: {ext}")


# ─── Main entry point ─────────────────────────────────────────────────────────

def run(cfg: Config) -> dict:
    """Fetch and embed cover art for available tracks that lack artwork.

    Behaviour:
    - Skips tracks with ``cover_art_written = 1`` in the DB (already processed).
    - Skips files that already have embedded art, unless ``force = true``.
    - Records ``cover_art_written = 1`` after a successful embed.
    - ``skip_embed = true`` performs a dry-run (fetch only, no file writes).

    Returns stats: ``{embedded, failed, skipped, no_art_found}``.
    """
    ca = cfg.cover_art
    sources = [s.strip() for s in ca.sources.split() if s.strip()]
    force = ca.force
    skip_embed = ca.skip_embed
    minwidth = ca.minwidth
    maxwidth = ca.maxwidth
    quality = ca.quality
    lastfm_api_key = ca.lastfm_api_key
    spotify_client_id = ca.spotify_client_id
    spotify_client_secret = ca.spotify_client_secret

    stats: dict[str, int] = {
        "embedded": 0,
        "failed": 0,
        "skipped": 0,
        "no_art_found": 0,
    }

    base_query = """
        SELECT id, title, artist, album, local_path, spotify_uri
        FROM tracks
        WHERE acquisition_status = 'available'
          AND local_path IS NOT NULL
    """
    if not force:
        base_query += " AND cover_art_written = 0"
    base_query += " ORDER BY id"

    with connect(cfg.db_path) as conn:
        rows = conn.execute(base_query).fetchall()

    if not rows:
        console.print("[dim]No tracks need cover art.[/dim]")
        return stats

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Embedding cover art", total=len(rows))

        for row in rows:
            track_id = row["id"]
            path = Path(row["local_path"])
            artist = row["artist"] or ""
            album = row["album"] or ""
            title = row["title"] or ""
            progress.update(task, description=f"[dim]{artist} – {title}[/dim]")

            if not path.exists():
                stats["skipped"] += 1
                progress.advance(task)
                continue

            if path.suffix.lower() not in _EMBEDDABLE_EXTS:
                stats["skipped"] += 1
                progress.advance(task)
                continue

            # Already has embedded art?
            if not force and _has_cover_art(path):
                with connect(cfg.db_path) as conn:
                    conn.execute(
                        "UPDATE tracks SET cover_art_written = 1 WHERE id = ?",
                        (track_id,),
                    )
                    conn.commit()
                stats["skipped"] += 1
                progress.advance(task)
                continue

            if skip_embed:
                stats["skipped"] += 1
                progress.advance(task)
                continue

            # Fetch art from configured sources
            img_data = _fetch_art(
                artist, album, title, sources,
                spotify_uri=row["spotify_uri"],
                spotify_client_id=spotify_client_id,
                spotify_client_secret=spotify_client_secret,
                lastfm_api_key=lastfm_api_key,
            )
            if not img_data:
                log.warning("no cover art found: %r / %r", artist, album)
                stats["no_art_found"] += 1
                progress.advance(task)
                continue

            # Validate minimum width
            try:
                w, _ = _image_dimensions(img_data)
                if w < minwidth:
                    log.debug(
                        "image too small (%dpx < minwidth %dpx) for %r / %r",
                        w, minwidth, artist, album,
                    )
                    stats["no_art_found"] += 1
                    progress.advance(task)
                    continue
                if w > maxwidth:
                    img_data = _resize_to_maxwidth(img_data, maxwidth, quality)
            except ValueError:
                pass  # unknown image format — proceed anyway

            # Embed
            try:
                _embed(path, img_data)
                with connect(cfg.db_path) as conn:
                    conn.execute(
                        "UPDATE tracks SET cover_art_written = 1,"
                        " cover_art_embedded_at = CURRENT_TIMESTAMP WHERE id = ?",
                        (track_id,),
                    )
                    conn.commit()
                stats["embedded"] += 1
            except Exception as exc:
                log.error("embed failed for %s: %s", path, exc)
                stats["failed"] += 1

            progress.advance(task)
            time.sleep(0.5)  # polite rate limiting between API calls

    return stats
