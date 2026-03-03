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

import json
import logging
import numpy as np
from pathlib import Path

from djtoolkit.config import Config, AudioAnalysisConfig
from djtoolkit.db.database import connect

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


def run(cfg: Config) -> dict:
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

    with connect(cfg.db_path) as conn:
        tracks = conn.execute("""
            SELECT id, local_path, genres, instrumentalness
            FROM tracks
            WHERE acquisition_status = 'available'
              AND enriched_audio = 0
              AND local_path IS NOT NULL
        """).fetchall()

    tracks = [dict(t) for t in tracks]

    # ── Phase 1+2: TF embeddings + classifiers (optional) ────────────────────
    if _have_tf_models and musicnn_path:
        import essentia.standard as es
        for track in tracks:
            tid = track["id"]
            path = Path(track["local_path"])
            if not path.exists():
                continue
            with connect(cfg.db_path) as conn:
                exists = conn.execute(
                    "SELECT 1 FROM track_embeddings WHERE track_id = ?", (tid,)
                ).fetchone()
            if exists:
                continue
            try:
                audio_16k = es.MonoLoader(filename=str(path), sampleRate=16000)()
                embeddings = es.TensorflowPredictMusiCNN(
                    graphFilename=musicnn_path,
                    output="model/dense/BiasAdd",
                )(audio_16k)
                with connect(cfg.db_path) as conn:
                    conn.execute(
                        "INSERT OR REPLACE INTO track_embeddings (track_id, model, embedding) VALUES (?,?,?)",
                        (tid, "msd-musicnn-1", embeddings.astype(np.float32).tobytes()),
                    )
                    conn.commit()
            except Exception as exc:
                log.warning("Embedding failed for track %d: %s", tid, exc)

        with connect(cfg.db_path) as conn:
            embedded = conn.execute(
                "SELECT track_id, embedding FROM track_embeddings"
            ).fetchall()

        for row in embedded:
            tid = int(row["track_id"])
            track = next((t for t in tracks if t["id"] == tid), None)
            if track is None:
                continue
            try:
                embeddings = np.frombuffer(row["embedding"], dtype=np.float32).reshape(1, -1)
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
                set_clause = ", ".join(f"{col} = ?" for col in updates)
                with connect(cfg.db_path) as conn:
                    conn.execute(
                        f"UPDATE tracks SET {set_clause} WHERE id = ?",
                        list(updates.values()) + [tid],
                    )
                    conn.commit()

    # ── Phase 3: Fast features via librosa (cross-platform) ──────────────────
    for track in tracks:
        tid = track["id"]
        path = Path(track["local_path"])
        if not path.exists():
            stats["skipped"] += 1
            continue

        try:
            y, sr = librosa.load(str(path), sr=None, mono=True)

            # BPM
            tempo_arr, beats = librosa.beat.beat_track(y=y, sr=sr)
            bpm = float(np.atleast_1d(tempo_arr)[0])

            # Key + Mode (Krumhansl-Schmuckler)
            chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
            key_int, mode = _detect_key(chroma.mean(axis=1))

            # Loudness — EBU R128 LUFS via pyloudnorm, RMS dB as fallback
            if _have_pyloudnorm:
                import pyloudnorm as pyln
                meter = pyln.Meter(sr)
                integrated_lufs = meter.integrated_loudness(y.astype(np.float64))
                loudness = float(integrated_lufs)
            else:
                rms = librosa.feature.rms(y=y).mean()
                loudness = float(librosa.amplitude_to_db(np.array([rms]))[0])

            # Danceability
            dance = _danceability(y, sr)

            updates: dict[str, object] = {
                "tempo": bpm,
                "key": key_int,
                "mode": mode,
                "danceability": dance,
                "loudness": loudness,
                "enriched_audio": 1,
            }

            set_clause = ", ".join(f"{col} = ?" for col in updates)
            with connect(cfg.db_path) as conn:
                conn.execute(
                    f"UPDATE tracks SET {set_clause} WHERE id = ?",
                    list(updates.values()) + [tid],
                )
                conn.commit()

            stats["analyzed"] += 1
            log.debug("Track %d: bpm=%.1f key=%s/%s dance=%.2f loud=%.1f",
                      tid, bpm, _KEY_NAMES[key_int], "major" if mode else "minor", dance, loudness)

        except Exception as exc:
            log.warning("Analysis failed for track %d (%s): %s", tid, path.name, exc)
            stats["failed"] += 1

    return stats
