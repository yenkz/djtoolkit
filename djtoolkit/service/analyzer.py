"""Mix analyzer — identify tracks in DJ mixes via boundary detection + Shazam.

Inspired by https://github.com/PierreGallet/shazamer:
  1. Download audio from YouTube/SoundCloud via yt-dlp
  2. Detect song boundaries via spectral analysis (librosa)
  3. Identify each segment via Shazam (shazamio)
  4. Deduplicate results

Runs on the Hetzner FastAPI service, not on user machines.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile
from typing import Callable, Awaitable

from shazamio import Shazam

# ─── Types ────────────────────────────────────────────────────────────────────

ProgressCallback = Callable[[int, str], Awaitable[None]] | None


def _log(msg: str):
    print(f"[analyzer] {msg}", flush=True)


# ─── Download ─────────────────────────────────────────────────────────────────

# Primary proxy from env, plus fallback SOCKS5 servers (NordVPN).
# Each will be tried in order if the previous fails.
_PROXY_PRIMARY = os.environ.get("YTDLP_PROXY", "")
_PROXY_CREDS = os.environ.get("YTDLP_PROXY_CREDS", "")  # user:pass (shared across servers)

_FALLBACK_SERVERS = [
    "stockholm.se.socks.nordhold.net:1080",
    "nl.socks.nordhold.net:1080",
    "us.socks.nordhold.net:1080",
    "dallas.us.socks.nordhold.net:1080",
]


def _build_proxy_list() -> list[str]:
    """Build ordered list of proxy URLs to try."""
    proxies = []
    if _PROXY_PRIMARY:
        proxies.append(_PROXY_PRIMARY)

    if _PROXY_CREDS:
        for server in _FALLBACK_SERVERS:
            proxy = f"socks5://{_PROXY_CREDS}@{server}"
            if proxy not in proxies:
                proxies.append(proxy)

    return proxies


def _try_download(url: str, output_template: str, proxy: str | None) -> tuple[bool, str]:
    """Attempt a single yt-dlp download. Returns (success, stderr)."""
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--format", "bestaudio/best",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "192K",
        "--output", output_template,
        "--js-runtimes", "deno",
    ]
    if proxy:
        cmd.extend(["--proxy", proxy])
    cmd.append(url)

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    return result.returncode == 0, result.stderr.strip()


def download_audio(
    url: str,
    output_dir: str,
    on_attempt: Callable[[int, int, str], None] | None = None,
) -> str:
    """Download audio from YouTube/SoundCloud to MP3 via yt-dlp CLI.

    Tries multiple proxy servers if the primary fails. Calls on_attempt(attempt, total, server)
    for each attempt so the UI can show progress.
    """
    output_template = os.path.join(output_dir, "mix.%(ext)s")
    proxies = _build_proxy_list()

    if not proxies:
        # No proxy — try direct (works for SoundCloud)
        proxies = [""]

    total_attempts = len(proxies)
    last_error = ""

    for i, proxy in enumerate(proxies):
        server_name = proxy.split("@")[-1] if "@" in proxy else ("direct" if not proxy else proxy)
        attempt = i + 1
        _log(f"Download attempt {attempt}/{total_attempts} via {server_name}")

        if on_attempt:
            on_attempt(attempt, total_attempts, server_name)

        success, stderr = _try_download(url, output_template, proxy or None)

        if success:
            _log(f"Download succeeded on attempt {attempt} via {server_name}")
            break

        last_error = stderr
        _log(f"Attempt {attempt} failed: {stderr[:200]}")

        # Clean up partial downloads before retry
        for f in os.listdir(output_dir):
            if f.startswith("mix."):
                os.remove(os.path.join(output_dir, f))
    else:
        raise RuntimeError(f"yt-dlp failed after {total_attempts} attempts: {last_error}")

    mp3_path = os.path.join(output_dir, "mix.mp3")
    if not os.path.exists(mp3_path):
        for f in os.listdir(output_dir):
            if f.endswith(".mp3"):
                mp3_path = os.path.join(output_dir, f)
                break
        else:
            raise RuntimeError("yt-dlp did not produce an MP3 file")

    size_mb = os.path.getsize(mp3_path) / 1e6
    _log(f"Downloaded audio: {mp3_path} ({size_mb:.1f} MB)")
    return mp3_path


# ─── Boundary Detection ──────────────────────────────────────────────────────

def generate_sample_points(
    audio_path: str,
    interval_sec: int = 45,
) -> list[float]:
    """Generate fixed-interval sample points for Shazam identification.

    Instead of spectral boundary detection (which requires tuning and is
    unreliable with streaming block processing), sample at regular intervals.
    This is the approach used by soundcloud-dj-set-analyzer and is more
    reliable across all mix styles.

    Returns list of sample timestamps in seconds.
    """
    import soundfile as sf

    info = sf.info(audio_path)
    duration = info.duration
    _log(f"Audio duration: {duration:.0f} seconds ({duration / 60:.1f} min), sampling every {interval_sec}s")

    # Generate sample points, skipping first 30s (often intro/jingle)
    points = []
    t = 30.0
    while t < duration - 15:
        points.append(round(t, 2))
        t += interval_sec

    _log(f"Generated {len(points)} sample points")
    return points


# ─── Segment Extraction ──────────────────────────────────────────────────────

def _extract_segment(audio_path: str, start_sec: float, duration_sec: float, output_path: str):
    """Extract a segment from an audio file using ffmpeg (zero RAM loading)."""
    import subprocess as sp
    sp.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", str(start_sec),
        "-t", str(duration_sec),
        "-i", audio_path,
        "-acodec", "libmp3lame",
        "-b:a", "128k",
        output_path,
    ], capture_output=True, timeout=30)


# ─── Segment Identification ──────────────────────────────────────────────────

async def identify_samples(
    audio_path: str,
    sample_points: list[float],
    sample_duration_sec: float = 10.0,
    cooldown_sec: float = 2.5,
    on_progress: ProgressCallback = None,
) -> list[dict]:
    """Identify tracks at each sample point via Shazam.

    Uses ffmpeg to extract each sample directly from the file — never loads
    the entire audio into memory (critical for 4GB servers with long mixes).
    """
    shazam = Shazam()
    results: list[dict] = []
    total = len(sample_points)
    tmp_dir = tempfile.mkdtemp(prefix="djtoolkit-seg-")

    _log(f"Identifying {total} samples via Shazam ({sample_duration_sec}s each)")

    try:
        for i, timestamp in enumerate(sample_points):
            seg_path = os.path.join(tmp_dir, f"seg_{i:04d}.mp3")
            _extract_segment(audio_path, timestamp, sample_duration_sec, seg_path)

            if not os.path.exists(seg_path):
                _log(f"  [{i+1}/{total}] {timestamp:.0f}s: segment extraction failed")
                continue

            pct = int(10 + 80 * (i + 1) / total)
            if on_progress:
                found = len(results)
                await on_progress(pct, f"Identifying {i + 1}/{total} samples ({found} found)…")

            try:
                result = await shazam.recognize(seg_path)
                track = result.get("track")
                if track:
                    matches = result.get("matches", [])
                    conf = _calc_confidence(matches)
                    # Extract Apple Music preview URL from hub actions
                    preview_url = ""
                    for action in (track.get("hub", {}).get("actions") or []):
                        if action.get("type") == "applemusicplay":
                            preview_url = action.get("uri", "")
                            break
                    # Extract artwork URL
                    images = track.get("images") or {}
                    artwork_url = images.get("coverarthq") or images.get("coverart") or ""
                    results.append({
                        "artist": track.get("subtitle", ""),
                        "title": track.get("title", ""),
                        "timestamp": timestamp,
                        "confidence": conf,
                        "shazam_key": track.get("key", ""),
                        "preview_url": preview_url,
                        "artwork_url": artwork_url,
                    })
                    _log(f"  [{i+1}/{total}] {timestamp:.0f}s: {track.get('subtitle', '?')} - {track.get('title', '?')} (conf={conf:.2f})")
                else:
                    _log(f"  [{i+1}/{total}] {timestamp:.0f}s: not identified")
            except Exception as e:
                _log(f"  [{i+1}/{total}] {timestamp:.0f}s: Shazam error: {e}")

            await asyncio.sleep(cooldown_sec)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    _log(f"Shazam identified {len(results)}/{total} samples")
    return results


def _calc_confidence(matches: list) -> float:
    """Calculate confidence score from Shazam match data."""
    if not matches:
        return 0.0
    unique_ids = {m.get("id") for m in matches if m.get("id")}
    count = len(unique_ids) or len(matches)
    if count <= 5:
        return 0.95
    if count <= 10:
        return 0.85
    if count <= 15:
        return 0.70
    return 0.50


# ─── Deduplication ───────────────────────────────────────────────────────────

def deduplicate(tracks: list[dict]) -> list[dict]:
    """Remove duplicate tracks, keeping the one with highest confidence."""
    seen: dict[str, dict] = {}
    for t in tracks:
        key = f"{(t.get('title') or '').lower().strip()}|{(t.get('artist') or '').lower().strip()}"
        if key not in seen or t.get("confidence", 0) > seen[key].get("confidence", 0):
            seen[key] = t
    return sorted(seen.values(), key=lambda t: t.get("timestamp", 0))


# ─── Full Pipeline ───────────────────────────────────────────────────────────

async def analyze_mix(
    url: str,
    cooldown_sec: float = 2.5,
    sample_interval_sec: int = 45,
    on_progress: ProgressCallback = None,
) -> list[dict]:
    """Full analysis pipeline: download → sample → identify → dedup."""
    tmp_dir = tempfile.mkdtemp(prefix="djtoolkit-mix-")

    try:
        # Download with retry across multiple proxy servers
        def on_download_attempt(attempt: int, total: int, server: str):
            if on_progress:
                import asyncio
                loop = asyncio.get_event_loop()
                if attempt == 1:
                    msg = f"Downloading audio…"
                else:
                    msg = f"Retrying download (attempt {attempt}/{total}, server: {server})…"
                loop.create_task(on_progress(5, msg))

        if on_progress:
            await on_progress(5, "Downloading audio…")
        audio_path = download_audio(url, tmp_dir, on_attempt=on_download_attempt)

        if on_progress:
            await on_progress(10, "Preparing samples…")
        sample_points = generate_sample_points(audio_path, sample_interval_sec)

        if on_progress:
            await on_progress(10, f"Identifying 0/{len(sample_points)} samples…")

        raw_tracks = await identify_samples(
            audio_path, sample_points, cooldown_sec=cooldown_sec,
            on_progress=on_progress,
        )

        if on_progress:
            await on_progress(95, "Deduplicating results…")
        tracks = deduplicate(raw_tracks)

        if on_progress:
            await on_progress(100, f"Done — {len(tracks)} tracks identified")

        _log(f"Analysis complete: {len(tracks)} unique tracks from {len(sample_points)} samples")
        return tracks

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
