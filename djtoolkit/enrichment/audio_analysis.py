"""
Audio analysis enrichment — fast features + optional TF genre/instrumental classifiers.

Fast features (cross-platform, Python 3.14, Apple Silicon, Windows):
  BPM          — librosa.beat.beat_track
  Key/Mode     — Krumhansl-Schmuckler algorithm via librosa chroma
  Loudness     — pyloudnorm EBU R128 integrated (LUFS), matching Spotify's scale
  Danceability — rhythmic consistency score (beat strength variance)

TF classifiers (optional — requires essentia-tensorflow, Linux/macOS x86_64, Python ≤3.11):
  Phase 1: MusicNN embeddings stored in track_embeddings table
  Phase 2: Discogs genre + vocal/instrumental classifiers on stored embeddings

Requires: librosa, pyloudnorm
Optional: essentia-tensorflow (for genre + instrumental classification)
Models:   https://essentia.upf.edu/models/
"""

from __future__ import annotations

# Ensure numba is not required — librosa works without it but some versions
# raise ImportError instead of falling back. Pre-install a stub so the import
# chain doesn't break in PyInstaller builds where numba is excluded.
import sys
if "numba" not in sys.modules:
    try:
        import numba  # noqa: F401
    except ImportError:
        import types
        _numba = types.ModuleType("numba")
        _numba.__version__ = "0.0.0"  # type: ignore[attr-defined]
        _numba.jit = lambda *a, **kw: (lambda f: f)  # type: ignore[attr-defined]
        _numba.vectorize = lambda *a, **kw: (lambda f: f)  # type: ignore[attr-defined]
        _numba.guvectorize = lambda *a, **kw: (lambda f: f)  # type: ignore[attr-defined]
        _numba.prange = range  # type: ignore[attr-defined]
        sys.modules["numba"] = _numba
        # Also stub numba.core if needed
        _core = types.ModuleType("numba.core")
        _core.types = types.ModuleType("numba.core.types")  # type: ignore[attr-defined]
        sys.modules["numba.core"] = _core
        sys.modules["numba.core.types"] = _core.types

import json
import logging
import numpy as np
from pathlib import Path
from typing import TYPE_CHECKING

from djtoolkit.config import Config, AudioAnalysisConfig

if TYPE_CHECKING:
    from djtoolkit.adapters.supabase import SupabaseAdapter

log = logging.getLogger("djtoolkit.enrichment.audio_analysis")

_KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler tonal hierarchy profiles
_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _detect_key(chroma_mean: np.ndarray) -> tuple[int, int]:
    """Return (key_int, mode) using Krumhansl-Schmuckler correlation."""
    best_key, best_mode, best_score = 0, 1, -np.inf
    for k in range(12):
        rotated = np.roll(chroma_mean, -k)
        maj = float(np.corrcoef(rotated, _MAJOR_PROFILE)[0, 1])
        min_ = float(np.corrcoef(rotated, _MINOR_PROFILE)[0, 1])
        if maj > best_score:
            best_key, best_mode, best_score = k, 1, maj
        if min_ > best_score:
            best_key, best_mode, best_score = k, 0, min_
    return best_key, best_mode


def _danceability(y: np.ndarray, sr: int) -> float:
    """Approximate danceability as rhythmic consistency (0–1).

    Higher = more stable, regular beat → more danceable.
    Based on variance of beat-to-beat intervals.
    """
    try:
        _, beats = __import__("librosa").beat.beat_track(y=y, sr=sr)
        if len(beats) < 4:
            return 0.5
        intervals = np.diff(beats.astype(float))
        cv = intervals.std() / (intervals.mean() + 1e-9)  # coefficient of variation
        return float(np.clip(1.0 - cv, 0.0, 1.0))
    except Exception:
        return 0.5


def _energy(y: np.ndarray, sr: int) -> float:
    """Approximate energy as perceptual intensity (0–1).

    Combines RMS loudness, spectral brightness (centroid), and onset density.
    Mirrors Spotify's energy: "a perceptual measure of intensity and activity".
    """
    librosa = __import__("librosa")

    # RMS energy → normalized to 0–1 (silence ~-60 dB, loud ~0 dB)
    rms = librosa.feature.rms(y=y).mean()
    rms_db = float(librosa.amplitude_to_db(np.array([rms]))[0])
    rms_norm = float(np.clip((rms_db + 60.0) / 60.0, 0.0, 1.0))

    # Spectral centroid → brightness, normalized against Nyquist
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr).mean()
    nyquist = sr / 2.0
    bright_norm = float(np.clip(centroid / nyquist, 0.0, 1.0))

    # Onset rate → how many note attacks per second (high = energetic)
    onsets = librosa.onset.onset_detect(y=y, sr=sr)
    duration = len(y) / sr
    onset_rate = len(onsets) / max(duration, 1.0)
    # Typical range 0–8 onsets/sec; cap at 10 for normalization
    onset_norm = float(np.clip(onset_rate / 10.0, 0.0, 1.0))

    # Weighted combination: loudness dominates, brightness and onsets contribute
    return float(np.clip(0.5 * rms_norm + 0.25 * bright_norm + 0.25 * onset_norm, 0.0, 1.0))


def _resolve_model(cfg_path: str, models_dir: str, filename: str) -> str | None:
    if cfg_path:
        return cfg_path
    candidate = Path(models_dir).expanduser() / filename
    return str(candidate) if candidate.exists() else None


def _normalize_discogs_genre(label: str) -> str:
    """'Electronic---House' → 'house'"""
    return label.split("---")[-1].strip().lower()


def _top_genres(predictions: np.ndarray, labels: list[str], top_n: int, threshold: float) -> str:
    mean_preds = np.array(predictions).mean(axis=0)
    ranked = sorted(enumerate(mean_preds), key=lambda x: x[1], reverse=True)
    seen: set[str] = set()
    unique: list[str] = []
    for i, score in ranked:
        if score < threshold:
            break
        tag = _normalize_discogs_genre(labels[i])
        if tag not in seen:
            seen.add(tag)
            unique.append(tag)
        if len(unique) >= top_n:
            break
    return ", ".join(unique)


def analyze_single(path: Path) -> dict:
    """Run fast audio features on a single file. Returns feature dict.

    Handles its own imports (librosa, pyloudnorm) so it can be called
    independently of run(). Raises FileNotFoundError if path doesn't exist.

    Returns dict with keys: tempo, key, mode, danceability, energy, loudness.
    """
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    import librosa

    try:
        import pyloudnorm as pyln
        _have_pyloudnorm = True
    except ImportError:
        _have_pyloudnorm = False

    y, sr = librosa.load(str(path), sr=None, mono=True)

    # BPM
    tempo_arr, beats = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo_arr)[0])

    # Key + Mode (Krumhansl-Schmuckler)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    key_int, mode = _detect_key(chroma.mean(axis=1))

    # Loudness
    if _have_pyloudnorm:
        meter = pyln.Meter(sr)
        loudness = float(meter.integrated_loudness(y.astype(np.float64)))
    else:
        rms = librosa.feature.rms(y=y).mean()
        loudness = float(librosa.amplitude_to_db(np.array([rms]))[0])

    # Danceability + Energy (these use __import__("librosa") internally — safe)
    dance = _danceability(y, sr)
    nrg = _energy(y, sr)

    return {
        "tempo": bpm,
        "key": key_int,
        "mode": mode,
        "danceability": dance,
        "energy": nrg,
        "loudness": loudness,
    }


def run(cfg: Config, adapter: "SupabaseAdapter", user_id: str) -> dict:
    """
    Run audio analysis on all imported tracks.

    Returns {"analyzed": N, "failed": N, "skipped": N}.
    """
    try:
        import librosa
    except ImportError:
        log.error("librosa is not installed. Run: pip install librosa")
        return {"analyzed": 0, "failed": 0, "skipped": 0}

    try:
        import pyloudnorm as pyln  # noqa: F401
        _have_pyloudnorm = True
    except ImportError:
        log.warning("pyloudnorm not installed — loudness will use RMS dB (not LUFS). pip install pyloudnorm")
        _have_pyloudnorm = False

    # Optional TF classifiers via essentia-tensorflow
    _have_tf_models = False
    try:
        import essentia.standard as es  # noqa: F401
        _have_tf_models = True
    except ImportError:
        pass

    ac: AudioAnalysisConfig = cfg.audio_analysis
    models_dir = str(Path(ac.models_dir).expanduser())

    musicnn_path = _resolve_model(ac.musicnn_model, models_dir, "msd-musicnn-1.pb")
    genre_model_path = _resolve_model(ac.discogs_genre_model, models_dir, "genre_discogs400-discogs-musicnn-1.pb")
    genre_labels_path = _resolve_model(ac.discogs_genre_labels, models_dir, "genre_discogs400-discogs-musicnn-1-labels.json")
    instrumental_path = _resolve_model(ac.instrumental_model, models_dir, "voice_instrumental-audioset-musicnn-1.pb")

    genre_labels: list[str] = []
    if genre_labels_path and Path(genre_labels_path).exists():
        with open(genre_labels_path) as f:
            genre_labels = json.load(f)

    stats = {"analyzed": 0, "failed": 0, "skipped": 0}

    track_objs = adapter.query_available_unenriched_audio(user_id)
    # Convert to dicts for backward compat with rest of function
    tracks = [{"id": t._id, "local_path": t.file_path, "genres": t.genres, "instrumentalness": t.instrumentalness} for t in track_objs]

    # ── Phase 1+2: TF embeddings + classifiers (optional) ────────────────────
    if _have_tf_models and musicnn_path:
        import essentia.standard as es
        for track in tracks:
            tid = track["id"]
            path = Path(track["local_path"])
            if not path.exists():
                continue
            exists = adapter.get_embedding(tid)
            if exists:
                continue
            try:
                audio_16k = es.MonoLoader(filename=str(path), sampleRate=16000)()
                embeddings = es.TensorflowPredictMusiCNN(
                    graphFilename=musicnn_path,
                    output="model/dense/BiasAdd",
                )(audio_16k)
                adapter.upsert_embedding(tid, "msd-musicnn-1", embeddings.astype(np.float32).tobytes())
            except Exception as exc:
                log.warning("Embedding failed for track %d: %s", tid, exc)

        embedded = adapter.get_all_embeddings()

        for row in embedded:
            tid = int(row["track_id"])
            track = next((t for t in tracks if t["id"] == tid), None)
            if track is None:
                continue
            try:
                raw = row["embedding"]
                if isinstance(raw, str) and raw.startswith("\\x"):
                    emb_bytes = bytes.fromhex(raw[2:])
                elif isinstance(raw, bytes):
                    emb_bytes = raw
                else:
                    continue
                embeddings = np.frombuffer(emb_bytes, dtype=np.float32).reshape(1, -1)
            except Exception as exc:
                log.warning("Failed to restore embedding for track %d: %s", tid, exc)
                continue

            updates: dict[str, object] = {}
            if genre_model_path and genre_labels and track.get("genres") is None:
                try:
                    preds = es.TensorflowPredict2D(
                        graphFilename=genre_model_path, output="model/Softmax"
                    )(embeddings)
                    genres_str = _top_genres(preds, genre_labels, ac.genre_top_n, ac.genre_threshold)
                    if genres_str:
                        updates["genres"] = genres_str
                except Exception as exc:
                    log.warning("Genre classification failed for track %d: %s", tid, exc)

            if instrumental_path and track.get("instrumentalness") is None:
                try:
                    preds = es.TensorflowPredict2D(
                        graphFilename=instrumental_path, output="model/Softmax"
                    )(embeddings)
                    mean_preds = np.array(preds).mean(axis=0)
                    updates["instrumentalness"] = float(mean_preds[1]) if len(mean_preds) > 1 else float(mean_preds[0])
                except Exception as exc:
                    log.warning("Instrumental classification failed for track %d: %s", tid, exc)

            if updates:
                adapter.update_track(tid, updates)

    # ── Phase 3: Fast features via librosa (cross-platform) ──────────────────
    for track in tracks:
        tid = track["id"]
        path = Path(track["local_path"])
        if not path.exists():
            stats["skipped"] += 1
            continue

        try:
            features = analyze_single(path)
            adapter.mark_enriched_audio(tid, features)
            stats["analyzed"] += 1
            log.debug("Track %d: bpm=%.1f key=%s/%s dance=%.2f energy=%.2f loud=%.1f",
                      tid, features["tempo"],
                      _KEY_NAMES[features["key"]],
                      "major" if features["mode"] else "minor",
                      features["danceability"], features["energy"],
                      features["loudness"])
        except Exception as exc:
            log.warning("Analysis failed for track %d (%s): %s", tid, path.name, exc)
            stats["failed"] += 1

    return stats
