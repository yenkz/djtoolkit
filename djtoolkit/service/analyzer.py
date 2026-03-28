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

import librosa
import numpy as np
import scipy.signal
from pydub import AudioSegment
from scipy.ndimage import gaussian_filter1d
from shazamio import Shazam

# ─── Types ────────────────────────────────────────────────────────────────────

ProgressCallback = Callable[[int, str], Awaitable[None]] | None


def _log(msg: str):
    print(f"[analyzer] {msg}", flush=True)


# ─── Download ─────────────────────────────────────────────────────────────────

_YTDLP_PROXY = os.environ.get("YTDLP_PROXY", "")


def download_audio(url: str, output_dir: str) -> str:
    """Download audio from YouTube/SoundCloud to MP3 via yt-dlp CLI."""
    output_template = os.path.join(output_dir, "mix.%(ext)s")
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--format", "bestaudio/best",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "192K",
        "--output", output_template,
        "--no-warnings",
        url,
    ]

    if _YTDLP_PROXY:
        cmd.insert(-1, "--proxy")
        cmd.insert(-1, _YTDLP_PROXY)

    _log(f"Downloading audio from: {url}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        stderr = result.stderr.strip()
        _log(f"yt-dlp stderr: {stderr}")
        raise RuntimeError(f"yt-dlp failed: {stderr}")

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

def detect_boundaries(
    audio_path: str,
    threshold: float = 0.0,
    min_duration_sec: int = 0,
) -> list[float]:
    """Detect song boundaries using spectral centroid + RMS energy analysis.

    Uses librosa.stream() to process in blocks — keeps memory under 500MB
    even for multi-hour mixes (critical for 4GB servers).
    """
    import soundfile as sf

    _log(f"Loading audio for boundary detection: {audio_path}")

    info = sf.info(audio_path)
    duration = info.duration
    sr = 22050
    _log(f"Audio duration: {duration:.0f} seconds ({duration / 60:.1f} min)")

    if threshold <= 0:
        if duration < 1200:
            threshold = 0.30
        elif duration < 3600:
            threshold = 0.20
        else:
            threshold = 0.15

    if min_duration_sec <= 0:
        if duration < 1200:
            min_duration_sec = 30
        elif duration < 3600:
            min_duration_sec = 60
        else:
            min_duration_sec = 90

    _log(f"Boundary detection: threshold={threshold:.2f}, min_duration={min_duration_sec}s")

    hop = 512
    centroid_blocks: list[np.ndarray] = []
    rms_blocks: list[np.ndarray] = []
    block_count = 0

    for block in librosa.stream(audio_path, block_length=30,
                                 frame_length=2048, hop_length=hop,
                                 mono=True):
        c = librosa.feature.spectral_centroid(y=block, sr=sr, hop_length=hop)[0]
        r = librosa.feature.rms(y=block, hop_length=hop)[0]
        centroid_blocks.append(c)
        rms_blocks.append(r)
        block_count += 1

    _log(f"Processed {block_count} audio blocks")

    if not centroid_blocks:
        _log("WARNING: No audio blocks processed — returning no boundaries")
        return [0.0, duration]

    centroid = np.concatenate(centroid_blocks)
    rms = np.concatenate(rms_blocks)
    del centroid_blocks, rms_blocks

    _log(f"Feature arrays: centroid={len(centroid)}, rms={len(rms)}")

    centroid_norm = (centroid - centroid.min()) / (centroid.max() - centroid.min() + 1e-8)
    rms_norm = (rms - rms.min()) / (rms.max() - rms.min() + 1e-8)

    combined = 0.5 * centroid_norm + 0.5 * rms_norm
    smoothed = gaussian_filter1d(combined, sigma=10)

    diff = np.abs(np.diff(smoothed))
    min_distance = int(min_duration_sec * sr / hop)
    peaks, properties = scipy.signal.find_peaks(diff, height=threshold, distance=min_distance)

    _log(f"Peak detection: {len(peaks)} peaks found (diff max={diff.max():.4f}, mean={diff.mean():.4f})")

    boundaries = [0.0]
    for p in peaks:
        t = p * hop / sr
        boundaries.append(round(t, 2))
    boundaries.append(round(duration, 2))

    _log(f"Detected {len(boundaries)} boundaries ({len(boundaries) - 1} segments)")
    return boundaries


# ─── Segment Identification ──────────────────────────────────────────────────

async def identify_segments(
    audio_path: str,
    boundaries: list[float],
    cooldown_sec: float = 2.5,
    on_progress: ProgressCallback = None,
) -> list[dict]:
    """Identify each segment between boundaries via Shazam."""
    audio = AudioSegment.from_file(audio_path)
    shazam = Shazam()
    results: list[dict] = []
    total_segments = len(boundaries) - 1
    tmp_dir = tempfile.mkdtemp(prefix="djtoolkit-seg-")

    _log(f"Identifying {total_segments} segments via Shazam")

    try:
        for i in range(total_segments):
            start_sec = boundaries[i]
            end_sec = boundaries[i + 1]
            segment_duration = end_sec - start_sec

            if segment_duration < 10:
                _log(f"  [{i+1}/{total_segments}] {start_sec:.0f}s: skipped (too short: {segment_duration:.0f}s)")
                continue

            mid_sec = (start_sec + end_sec) / 2
            sample_half = min(7.5, segment_duration / 2 - 1)
            sample_start_ms = int((mid_sec - sample_half) * 1000)
            sample_end_ms = int((mid_sec + sample_half) * 1000)
            segment = audio[sample_start_ms:sample_end_ms]

            seg_path = os.path.join(tmp_dir, f"seg_{i:04d}.mp3")
            segment.export(seg_path, format="mp3")

            pct = int(10 + 80 * (i + 1) / total_segments)
            if on_progress:
                await on_progress(pct, f"Identifying segment {i + 1}/{total_segments}…")

            try:
                result = await shazam.recognize(seg_path)
                track = result.get("track")
                if track:
                    matches = result.get("matches", [])
                    conf = _calc_confidence(matches)
                    results.append({
                        "artist": track.get("subtitle", ""),
                        "title": track.get("title", ""),
                        "timestamp": start_sec,
                        "duration": segment_duration,
                        "confidence": conf,
                        "shazam_key": track.get("key", ""),
                    })
                    _log(f"  [{i+1}/{total_segments}] {start_sec:.0f}s: {track.get('subtitle', '?')} - {track.get('title', '?')} (confidence={conf:.2f})")
                else:
                    _log(f"  [{i+1}/{total_segments}] {start_sec:.0f}s: not identified")
            except Exception as e:
                _log(f"  [{i+1}/{total_segments}] {start_sec:.0f}s: Shazam error: {e}")

            await asyncio.sleep(cooldown_sec)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    _log(f"Shazam identified {len(results)}/{total_segments} segments")
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
    boundary_threshold: float = 0.0,
    min_segment_sec: int = 0,
    on_progress: ProgressCallback = None,
) -> list[dict]:
    """Full analysis pipeline: download → detect → identify → dedup."""
    tmp_dir = tempfile.mkdtemp(prefix="djtoolkit-mix-")

    try:
        if on_progress:
            await on_progress(5, "Downloading audio…")
        audio_path = download_audio(url, tmp_dir)

        if on_progress:
            await on_progress(10, "Detecting song boundaries…")
        boundaries = detect_boundaries(audio_path, boundary_threshold, min_segment_sec)

        raw_tracks = await identify_segments(
            audio_path, boundaries, cooldown_sec, on_progress,
        )

        if on_progress:
            await on_progress(95, "Deduplicating results…")
        tracks = deduplicate(raw_tracks)

        if on_progress:
            await on_progress(100, f"Done — {len(tracks)} tracks identified")

        _log(f"Analysis complete: {len(tracks)} unique tracks from {len(boundaries) - 1} segments")
        return tracks

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
