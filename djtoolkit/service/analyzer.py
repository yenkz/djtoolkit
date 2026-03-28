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
import logging
import os
import shutil
import tempfile
from typing import Callable, Awaitable

import librosa
import numpy as np
import scipy.signal
from pydub import AudioSegment
from scipy.ndimage import gaussian_filter1d
from shazamio import Shazam

log = logging.getLogger(__name__)

# ─── Types ────────────────────────────────────────────────────────────────────

ProgressCallback = Callable[[int, str], Awaitable[None]] | None


# ─── Download ─────────────────────────────────────────────────────────────────

_COOKIES_PATH = os.environ.get("YTDLP_COOKIES", "/opt/djtoolkit/cookies.txt")


def download_audio(url: str, output_dir: str) -> str:
    """Download audio from YouTube/SoundCloud to MP3 via yt-dlp Python API.

    Uses cookies file if available (required for YouTube on server IPs to
    bypass bot detection). Falls back to cookieless download for SoundCloud.

    Returns the path to the downloaded MP3 file.
    """
    import yt_dlp

    output_template = os.path.join(output_dir, "mix.%(ext)s")

    ydl_opts: dict = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "outtmpl": output_template,
        "quiet": True,
        "no_warnings": True,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
    }

    # Copy cookies to a writable temp file (container runs as non-root user
    # but the mounted cookies file is owned by root)
    if os.path.exists(_COOKIES_PATH):
        tmp_cookies = os.path.join(output_dir, "cookies.txt")
        shutil.copy2(_COOKIES_PATH, tmp_cookies)
        ydl_opts["cookiefile"] = tmp_cookies
        log.info("Using cookies file: %s (%d bytes)", _COOKIES_PATH, os.path.getsize(_COOKIES_PATH))
    else:
        log.warning("No cookies file at %s — YouTube may block the download", _COOKIES_PATH)

    log.info("Downloading audio from: %s", url)
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
    except yt_dlp.utils.DownloadError as e:
        raise RuntimeError(f"yt-dlp failed: {e}") from e

    mp3_path = os.path.join(output_dir, "mix.mp3")
    if not os.path.exists(mp3_path):
        # yt-dlp may output with a different extension before conversion
        for f in os.listdir(output_dir):
            if f.endswith(".mp3"):
                mp3_path = os.path.join(output_dir, f)
                break
        else:
            raise RuntimeError("yt-dlp did not produce an MP3 file")

    log.info("Downloaded audio: %s (%.1f MB)", mp3_path, os.path.getsize(mp3_path) / 1e6)
    return mp3_path


# ─── Boundary Detection ──────────────────────────────────────────────────────

def detect_boundaries(
    audio_path: str,
    threshold: float = 0.0,
    min_duration_sec: int = 0,
) -> list[float]:
    """Detect song boundaries using spectral centroid + RMS energy analysis.

    Adapted from Shazamer's approach:
    - Compute spectral centroid (frequency balance) and RMS energy
    - Normalize, combine, smooth with Gaussian filter
    - Find peaks in the derivative (rapid spectral changes = transitions)
    - Auto-adjust threshold and min_duration based on audio length

    Returns a list of boundary timestamps in seconds (including 0.0 and end).
    """
    log.info("Loading audio for boundary detection: %s", audio_path)
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    duration = len(y) / sr
    log.info("Audio duration: %.0f seconds (%.1f min)", duration, duration / 60)

    # Auto-adjust parameters based on duration
    if threshold <= 0:
        if duration < 1200:       # <20 min
            threshold = 0.30
        elif duration < 3600:     # <60 min
            threshold = 0.20
        else:                     # >60 min
            threshold = 0.15

    if min_duration_sec <= 0:
        if duration < 1200:
            min_duration_sec = 30
        elif duration < 3600:
            min_duration_sec = 60
        else:
            min_duration_sec = 90

    log.info("Boundary detection: threshold=%.2f, min_duration=%ds", threshold, min_duration_sec)

    # Spectral features
    hop = 512
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop)[0]
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]

    # Normalize to 0-1
    centroid_norm = (centroid - centroid.min()) / (centroid.max() - centroid.min() + 1e-8)
    rms_norm = (rms - rms.min()) / (rms.max() - rms.min() + 1e-8)

    # Combine and smooth
    combined = 0.5 * centroid_norm + 0.5 * rms_norm
    smoothed = gaussian_filter1d(combined, sigma=10)

    # Find peaks in the derivative (rapid changes)
    diff = np.abs(np.diff(smoothed))
    min_distance = int(min_duration_sec * sr / hop)
    peaks, _ = scipy.signal.find_peaks(diff, height=threshold, distance=min_distance)

    # Convert frame indices to seconds
    boundaries = [0.0]
    for p in peaks:
        t = p * hop / sr
        boundaries.append(round(t, 2))
    boundaries.append(round(duration, 2))

    log.info("Detected %d boundaries (%d segments)", len(boundaries), len(boundaries) - 1)
    return boundaries


# ─── Segment Identification ──────────────────────────────────────────────────

async def identify_segments(
    audio_path: str,
    boundaries: list[float],
    cooldown_sec: float = 2.5,
    on_progress: ProgressCallback = None,
) -> list[dict]:
    """Identify each segment between boundaries via Shazam.

    For each segment:
    1. Extract a ~15s sample from the middle of the segment via pydub
    2. Send to Shazam for fingerprint matching
    3. Collect title, artist, confidence, timestamp

    Returns list of identified tracks (may contain duplicates for dedup later).
    """
    audio = AudioSegment.from_file(audio_path)
    shazam = Shazam()
    results: list[dict] = []
    total_segments = len(boundaries) - 1
    tmp_dir = tempfile.mkdtemp(prefix="djtoolkit-seg-")

    try:
        for i in range(total_segments):
            start_sec = boundaries[i]
            end_sec = boundaries[i + 1]
            segment_duration = end_sec - start_sec

            # Skip very short segments
            if segment_duration < 10:
                continue

            # Extract a sample from the middle of the segment (up to 15s)
            mid_sec = (start_sec + end_sec) / 2
            sample_half = min(7.5, segment_duration / 2 - 1)
            sample_start_ms = int((mid_sec - sample_half) * 1000)
            sample_end_ms = int((mid_sec + sample_half) * 1000)
            segment = audio[sample_start_ms:sample_end_ms]

            seg_path = os.path.join(tmp_dir, f"seg_{i:04d}.mp3")
            segment.export(seg_path, format="mp3")

            # Progress callback
            pct = int(10 + 80 * (i + 1) / total_segments)
            if on_progress:
                await on_progress(pct, f"Identifying segment {i + 1}/{total_segments}…")

            # Shazam identification
            try:
                result = await shazam.recognize(seg_path)
                track = result.get("track")
                if track:
                    matches = result.get("matches", [])
                    results.append({
                        "artist": track.get("subtitle", ""),
                        "title": track.get("title", ""),
                        "timestamp": start_sec,
                        "duration": segment_duration,
                        "confidence": _calc_confidence(matches),
                        "shazam_key": track.get("key", ""),
                    })
                    log.info(
                        "  [%d/%d] %.0fs: %s - %s (confidence=%.2f)",
                        i + 1, total_segments, start_sec,
                        track.get("subtitle", "?"), track.get("title", "?"),
                        results[-1]["confidence"],
                    )
                else:
                    log.info("  [%d/%d] %.0fs: not identified", i + 1, total_segments, start_sec)
            except Exception as e:
                log.warning("  [%d/%d] %.0fs: Shazam error: %s", i + 1, total_segments, start_sec, e)

            # Rate limiting
            await asyncio.sleep(cooldown_sec)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return results


def _calc_confidence(matches: list) -> float:
    """Calculate confidence score from Shazam match data.

    Adapted from Shazamer: fewer matches = higher confidence.
    Returns 0.0-1.0 where 1.0 is highest confidence.
    """
    if not matches:
        return 0.0

    # Deduplicate match IDs
    unique_ids = {m.get("id") for m in matches if m.get("id")}
    count = len(unique_ids) or len(matches)

    # Shazamer's heuristic: fewer unique matches = higher confidence
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
    # Sort by timestamp
    return sorted(seen.values(), key=lambda t: t.get("timestamp", 0))


# ─── Full Pipeline ───────────────────────────────────────────────────────────

async def analyze_mix(
    url: str,
    cooldown_sec: float = 2.5,
    boundary_threshold: float = 0.0,
    min_segment_sec: int = 0,
    on_progress: ProgressCallback = None,
) -> list[dict]:
    """Full analysis pipeline: download → detect → identify → dedup.

    Returns deduplicated list of identified tracks with timestamps.
    """
    tmp_dir = tempfile.mkdtemp(prefix="djtoolkit-mix-")

    try:
        # 1. Download
        if on_progress:
            await on_progress(5, "Downloading audio…")
        audio_path = download_audio(url, tmp_dir)

        # 2. Detect boundaries
        if on_progress:
            await on_progress(10, "Detecting song boundaries…")
        boundaries = detect_boundaries(audio_path, boundary_threshold, min_segment_sec)

        # 3. Identify segments
        raw_tracks = await identify_segments(
            audio_path, boundaries, cooldown_sec, on_progress,
        )

        # 4. Deduplicate
        if on_progress:
            await on_progress(95, "Deduplicating results…")
        tracks = deduplicate(raw_tracks)

        if on_progress:
            await on_progress(100, f"Done — {len(tracks)} tracks identified")

        log.info("Analysis complete: %d unique tracks from %d segments", len(tracks), len(boundaries) - 1)
        return tracks

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
