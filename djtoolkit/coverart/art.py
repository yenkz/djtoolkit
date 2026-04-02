"""djtoolkit.coverart.art
=======================

Fetch album cover art from online sources and embed it into audio files.

Sources (tried in order as configured in ``[cover_art] sources``):

  coverart  — Cover Art Archive (MusicBrainz) — free, no auth. Searches release-group by
              artist+album, then falls back to recording search by artist+title (better for singles)
  itunes    — iTunes Search API — free, returns up to 3000×3000 images (album-based)
  deezer    — Deezer Search API — free, no auth. Searches by artist+title → good for singles
  spotify   — Spotify API — uses ``spotify_uri`` if available, otherwise searches by artist+title.
              Discovered URIs are persisted back to the DB. Requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET in .env
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

from __future__ import annotations

import io
import json
import logging
import re
import struct
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Optional

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

if TYPE_CHECKING:
    from djtoolkit.adapters.supabase import SupabaseAdapter

log = logging.getLogger(__name__)
console = Console()

_EMBEDDABLE_EXTS = {".mp3", ".flac", ".m4a", ".aac"}
_USER_AGENT = "djtoolkit/1.0 (cover art fetcher)"

# ─── Metadata cleaning for search ─────────────────────────────────────────────

_LEADING_NUM_RE = re.compile(r"^\d+[\.\s]+")
_BLOG_PREFIX_RE = re.compile(r"^(Premiere|Exclusive|Preview|Edit)\s*:\s*", re.I)
_MULTI_ARTIST_RE = re.compile(r"\s+(?:feat\.?|ft\.?|vs\.?|presents?|\bx\b)\s+|\s*[&+]\s*", re.I)

_URL_RE = re.compile(r"https?://|\bwww\.\S|\S+\.(com|net|org|biz|info)\b", re.I)
_PROMO_RE = re.compile(r"\s*(OUT NOW|#\d+\s+ON\s+BEATPORT|FREE\s+DOWNLOAD).*$", re.I)
_DISC_SUFFIX_RE = re.compile(r"\s*[-/]\s*(?:CD|Disc)\s*\d+.*$", re.I)
_MIXED_BY_RE = re.compile(r"\s*[-/]\s*Mixed\s+by\s+.+$", re.I)
_DISC_PREFIX_RE = re.compile(r"^(?:CD|Disc)\s*\d+\s*[-–:]\s*", re.I)


def _clean_artist(artist: str) -> str:
    """Strip track number prefixes, blog prefixes, and trailing noise."""
    a = artist.strip()
    a = _BLOG_PREFIX_RE.sub("", a)       # "Premiere: Yaya" → "Yaya"
    a = _LEADING_NUM_RE.sub("", a)       # "07 Henry Saiz" → "Henry Saiz"
    return a.rstrip("_.").strip()


def _first_artist(artist: str) -> str:
    """Extract just the primary artist from a compound string."""
    return _MULTI_ARTIST_RE.split(_clean_artist(artist))[0].strip()


_DISC_ONLY_RE = re.compile(r"^(?:CD|Disc)\s*\d+$", re.I)


def _clean_album(album: str) -> str:
    """Return cleaned album name, or '' if the value is a URL / pure garbage."""
    a = album.strip()
    if not a or _URL_RE.search(a):
        return ""
    a = _PROMO_RE.sub("", a)        # "Ridin' Higher OUT NOW : #2 ON BEATPORT" → "Ridin' Higher"
    a = _MIXED_BY_RE.sub("", a)     # "Ibiza 2013 - CD 1 - Mixed by Simon Dunmore" → "Ibiza 2013"
    a = _DISC_SUFFIX_RE.sub("", a)  # "Ibiza 2013 - CD 1" → "Ibiza 2013"
    a = _DISC_PREFIX_RE.sub("", a)  # "CD1 - Eclectic Party" → "Eclectic Party"
    a = a.strip()
    if _DISC_ONLY_RE.match(a):      # "CD 2" alone → useless
        return ""
    return a


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

def _source_coverart_recording(artist: str, title: str) -> tuple[Optional[bytes], Optional[str]]:
    """MusicBrainz recording search — better than release-group search for singles."""
    query = urllib.parse.quote(f'artist:"{artist}" AND recording:"{title}"')
    data = _http_get_json(
        f"https://musicbrainz.org/ws/2/recording/?query={query}&fmt=json&limit=3"
    )
    if not data:
        return None, None
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
                        return img, url
    return None, None


def _source_coverart(artist: str, album: str, title: str = "") -> tuple[Optional[bytes], Optional[str]]:
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
                    url = f"https://coverartarchive.org/release-group/{mbid}/front-{size}"
                    img = _http_get_bytes(url)
                    if img:
                        return img, url
    # Fallback: recording search by track title (catches singles not in release-groups)
    if title and title != album:
        time.sleep(0.3)
        return _source_coverart_recording(artist, title)
    return None, None


def _source_itunes(artist: str, album: str) -> tuple[Optional[bytes], Optional[str]]:
    """iTunes Search API — scales artwork URL up to 3000×3000."""
    query = urllib.parse.quote(f"{artist} {album}")
    data = _http_get_json(
        f"https://itunes.apple.com/search?term={query}&entity=album&limit=5"
    )
    if not data or not data.get("results"):
        return None, None
    art_url = data["results"][0].get("artworkUrl100")
    if not art_url:
        return None, None
    art_url = art_url.replace("100x100bb", "3000x3000bb")
    img = _http_get_bytes(art_url)
    return (img, art_url) if img else (None, None)


def _source_deezer(artist: str, title: str) -> tuple[Optional[bytes], Optional[str]]:
    """Deezer Search API — free, no auth. Searches by track title (great for singles)."""
    query = urllib.parse.quote(f"{artist} {title}")
    data = _http_get_json(f"https://api.deezer.com/search?q={query}&limit=5")
    if not data or not data.get("data"):
        return None, None
    for result in data["data"]:
        url = result.get("album", {}).get("cover_xl")
        if url:
            img = _http_get_bytes(url)
            if img:
                return img, url
    return None, None


class _SpotifyResult:
    """Container for Spotify source results."""
    __slots__ = ("image", "artwork_url", "spotify_uri", "preview_url")

    def __init__(self, image: Optional[bytes] = None, artwork_url: Optional[str] = None,
                 spotify_uri: Optional[str] = None, preview_url: Optional[str] = None):
        self.image = image
        self.artwork_url = artwork_url
        self.spotify_uri = spotify_uri
        self.preview_url = preview_url


def _source_spotify(
    client_id: str,
    client_secret: str,
    *,
    spotify_uri: Optional[str] = None,
    artist: str = "",
    title: str = "",
) -> _SpotifyResult:
    """Fetch album artwork from Spotify.

    Returns a ``_SpotifyResult`` with image bytes, artwork URL, spotify_uri,
    and preview_url.

    When ``spotify_uri`` is provided, does a direct track lookup.
    When missing, searches by artist+title and picks the best match.

    Uses the Spotify Web API (Client Credentials flow).
    Picks the largest image from ``album.images``.
    Requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET in .env.
    """
    empty = _SpotifyResult()
    if not client_id or not client_secret:
        log.debug("Spotify source skipped — SPOTIFY_CLIENT_ID/SECRET not set")
        return empty
    try:
        import spotipy
        from spotipy.oauth2 import SpotifyClientCredentials
        sp = spotipy.Spotify(
            auth_manager=SpotifyClientCredentials(
                client_id=client_id,
                client_secret=client_secret,
            )
        )

        if not spotify_uri and artist and title:
            # Search by artist + title → use curated search_string cleaning
            from djtoolkit.utils.search_string import _clean
            clean_artist = _clean(artist.split(";")[0].strip())
            clean_title = _clean(title)
            q = f"artist:{clean_artist} track:{clean_title}"
            results = sp.search(q=q, type="track", limit=5)
            items = results.get("tracks", {}).get("items", [])
            if items:
                spotify_uri = items[0]["uri"]
                log.debug("Spotify search matched: %s → %s", q, spotify_uri)
            else:
                log.debug("Spotify search returned no results for: %s", q)
                return empty

        if not spotify_uri:
            return empty

        track = sp.track(spotify_uri)
        preview_url = track.get("preview_url")
        images = track.get("album", {}).get("images", [])
        if not images:
            return _SpotifyResult(spotify_uri=spotify_uri, preview_url=preview_url)
        best = max(images, key=lambda x: x.get("width", 0))
        art_url = best["url"]
        img = _http_get_bytes(art_url)
        return _SpotifyResult(
            image=img, artwork_url=art_url if img else None,
            spotify_uri=spotify_uri, preview_url=preview_url,
        )
    except Exception as exc:
        log.debug("Spotify source failed: %s", exc)
        return empty


def _source_lastfm(artist: str, album: str, api_key: str) -> tuple[Optional[bytes], Optional[str]]:
    """Last.fm album.getinfo — requires LASTFM_API_KEY."""
    url = (
        "http://ws.audioscrobbler.com/2.0/"
        f"?method=album.getinfo&artist={urllib.parse.quote(artist)}"
        f"&album={urllib.parse.quote(album)}&api_key={api_key}&format=json"
    )
    data = _http_get_json(url)
    if not data or "album" not in data:
        return None, None
    for size in ("mega", "extralarge", "large"):
        for img_entry in data["album"].get("image", []):
            if img_entry.get("size") == size and img_entry.get("#text"):
                art_url = img_entry["#text"]
                img = _http_get_bytes(art_url)
                if img:
                    return img, art_url
    return None, None


class FetchArtResult:
    """Container for _fetch_art results."""
    __slots__ = ("image", "spotify_uri", "artwork_url", "preview_url")

    def __init__(self, image: Optional[bytes] = None, spotify_uri: Optional[str] = None,
                 artwork_url: Optional[str] = None, preview_url: Optional[str] = None):
        self.image = image
        self.spotify_uri = spotify_uri
        self.artwork_url = artwork_url
        self.preview_url = preview_url


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
) -> FetchArtResult:
    """Try each configured source in order.

    Returns a ``FetchArtResult`` with image bytes, resolved spotify_uri,
    artwork_url (for UI display), and preview_url (from Spotify when available).

    Applies two search passes:
      Pass 1 — cleaned artist + cleaned album
      Pass 2 — first artist only (when artist was a compound "A & B feat. C" string)

    When album is empty/garbage after cleaning, album-based sources (coverart
    release-group, itunes, lastfm) fall back to track/title-based queries so
    they remain useful instead of making empty-album requests.
    """
    artist_c = _clean_artist(artist)
    album_c = _clean_album(album)
    first = _first_artist(artist)
    found_uri: Optional[str] = None
    found_artwork_url: Optional[str] = None
    found_preview_url: Optional[str] = None

    def _try(art: str, alb: str) -> Optional[bytes]:
        nonlocal found_uri, found_artwork_url, found_preview_url
        for source in sources:
            try:
                if source == "coverart":
                    # When album is known, try release-group search first (album art);
                    # when album is missing, go straight to recording search (single art).
                    img, art_url = _source_coverart(art, alb, title) if alb else _source_coverart_recording(art, title)
                elif source == "itunes":
                    img, art_url = _source_itunes(art, alb) if alb else (None, None)
                elif source == "deezer":
                    img, art_url = _source_deezer(art, title)
                elif source == "spotify":
                    sr = _source_spotify(
                        spotify_client_id, spotify_client_secret,
                        spotify_uri=spotify_uri, artist=art, title=title,
                    )
                    img, art_url = sr.image, sr.artwork_url
                    if sr.spotify_uri and sr.spotify_uri != spotify_uri:
                        found_uri = sr.spotify_uri
                    if sr.preview_url:
                        found_preview_url = sr.preview_url
                elif source == "lastfm":
                    img, art_url = _source_lastfm(art, alb, lastfm_api_key) if lastfm_api_key and alb else (None, None)
                else:
                    log.debug("unknown cover art source %r — skipping", source)
                    continue
            except Exception as exc:
                log.debug("source %r raised: %s", source, exc)
                img = None
                art_url = None
            if img:
                log.debug("fetched art from %r (%d bytes) [artist=%r album=%r]", source, len(img), art, alb)
                found_artwork_url = art_url
                return img
            time.sleep(0.3)
        return None

    def _result(image: Optional[bytes]) -> FetchArtResult:
        return FetchArtResult(
            image=image, spotify_uri=found_uri,
            artwork_url=found_artwork_url, preview_url=found_preview_url,
        )

    # Pass 1: cleaned artist + cleaned album
    result = _try(artist_c, album_c)
    if result:
        return _result(result)

    # Pass 2: first artist only — helps with "A & B feat. C" compound strings
    if first != artist_c:
        log.debug("retrying with first artist only: %r", first)
        result = _try(first, album_c)
        return _result(result)

    return _result(None)


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

def run(cfg: Config, adapter: "SupabaseAdapter", user_id: str) -> dict:
    """Fetch and embed cover art for available tracks that lack artwork.

    Behaviour:
    - Skips tracks with ``cover_art_written = True`` in the DB (already processed).
    - Skips files that already have embedded art, unless ``force = true``.
    - Records ``cover_art_written = True`` after a successful embed.
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

    if not force:
        tracks = adapter.query_missing_cover_art(user_id)
    else:
        tracks = adapter.load_tracks(user_id, {"acquisition_status": "available"})

    if not tracks:
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
        task = progress.add_task("Embedding cover art", total=len(tracks))

        for track in tracks:
            track_id = track._id
            path = Path(track.file_path) if track.file_path else None
            artist = track.artist or ""
            album = track.album or ""
            title = track.title or ""
            progress.update(task, description=f"[dim]{artist} – {title}[/dim]")

            if not path or not path.exists():
                stats["skipped"] += 1
                progress.advance(task)
                continue

            if path.suffix.lower() not in _EMBEDDABLE_EXTS:
                stats["skipped"] += 1
                progress.advance(task)
                continue

            # Already has embedded art?
            if not force and _has_cover_art(path):
                adapter.mark_cover_art_written(track_id)
                stats["skipped"] += 1
                progress.advance(task)
                continue

            if skip_embed:
                stats["skipped"] += 1
                progress.advance(task)
                continue

            # Fetch art from configured sources
            art_result = _fetch_art(
                artist, album, title, sources,
                spotify_uri=track.spotify_uri,
                spotify_client_id=spotify_client_id,
                spotify_client_secret=spotify_client_secret,
                lastfm_api_key=lastfm_api_key,
            )
            img_data = art_result.image

            # Persist newly discovered spotify_uri back to DB
            if art_result.spotify_uri and not track.spotify_uri:
                adapter.update_track(track_id, {"spotify_uri": art_result.spotify_uri})

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
                update: dict = {
                    "cover_art_written": True,
                    "cover_art_embedded_at": datetime.now(timezone.utc).isoformat(),
                }
                if art_result.artwork_url:
                    update["artwork_url"] = art_result.artwork_url
                if art_result.preview_url:
                    update["preview_url"] = art_result.preview_url
                adapter.update_track(track_id, update)
                stats["embedded"] += 1
            except Exception as exc:
                log.error("embed failed for %s: %s", path, exc)
                stats["failed"] += 1

            progress.advance(task)
            time.sleep(0.5)  # polite rate limiting between API calls

    return stats
