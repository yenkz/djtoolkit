# Source-Aware Pipeline Chain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Branch the pipeline chain after fingerprint based on `track.source`, adding Spotify lookup and audio analysis steps for non-exportify tracks.

**Architecture:** The chain engine in `job-result.ts` branches after fingerprint: exportify tracks go straight to cover_art → metadata; non-exportify tracks go through spotify_lookup → cover_art → audio_analysis → metadata. Two new Python modules handle the new job types, and the agent executor dispatches them.

**Tech Stack:** TypeScript (Next.js API routes), Python (spotipy, librosa, thefuzz), Supabase (PostgreSQL)

**Spec:** `docs/superpowers/specs/2026-03-19-source-aware-pipeline-design.md`

---

## File Structure

| Action | File | Responsibility |
| --- | --- | --- |
| Create | `djtoolkit/enrichment/spotify_lookup.py` | Single-track Spotify API search + metadata extraction |
| Create | `tests/test_spotify_lookup.py` | Tests for spotify_lookup module |
| Modify | `djtoolkit/enrichment/audio_analysis.py` | Extract `analyze_single()` public function |
| Create | `tests/test_audio_analysis.py` | Tests for `analyze_single()` |
| Modify | `djtoolkit/agent/executor.py` | Add `execute_spotify_lookup` + `execute_audio_analysis`; fix `execute_cover_art` kwargs |
| Modify | `djtoolkit/agent/runner.py:65-75` | Add `spotify_lookup` + `audio_analysis` to job dispatch match |
| Modify | `djtoolkit/agent/jobs/cover_art.py` | Fix to use `_fetch_art`/`_embed` with credentials |
| Create | `djtoolkit/agent/jobs/spotify_lookup.py` | Agent job wrapper for spotify_lookup |
| Create | `djtoolkit/agent/jobs/audio_analysis.py` | Agent job wrapper for audio_analysis |
| Modify | `web/lib/api-server/job-result.ts` | Branch after fingerprint/cover_art on source; add spotify_lookup + audio_analysis cases; extract `buildMetadataPayload` helper |
| Modify | `web/app/api/pipeline/jobs/[id]/result/route.ts` | Handle audio_analysis failure → continue chain |
| Modify | `web/app/api/pipeline/jobs/retry/route.ts` | Update DOWNSTREAM map |
| Modify | `web/lib/design-system/tokens.ts` | Add LED colors for new job types |

**Note on dual dispatch:** The agent has two code paths — `daemon.py` calls `executor.py` (inline handlers), while `runner.py` calls `agent/jobs/` modules. Both must be updated.

---

### Task 1: Create `spotify_lookup.py` module

**Files:**
- Create: `djtoolkit/enrichment/spotify_lookup.py`
- Create: `tests/test_spotify_lookup.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_spotify_lookup.py
"""Tests for enrichment/spotify_lookup.py — Spotify API search + metadata."""

from unittest.mock import MagicMock, patch

import pytest

from djtoolkit.enrichment.spotify_lookup import lookup_track


class TestLookupTrack:
    """Tests for lookup_track()."""

    def test_returns_none_when_no_credentials(self):
        result = lookup_track("Artist", "Title", client_id="", client_secret="")
        assert result is None

    def test_returns_none_when_no_search_results(self):
        with patch("djtoolkit.enrichment.spotify_lookup.spotipy") as mock_sp_mod:
            mock_sp = MagicMock()
            mock_sp_mod.Spotify.return_value = mock_sp
            mock_sp.search.return_value = {"tracks": {"items": []}}
            result = lookup_track("Artist", "Title",
                                  client_id="cid", client_secret="csec")
        assert result is None

    def test_returns_metadata_on_good_match(self):
        mock_track = {
            "uri": "spotify:track:abc123",
            "name": "My Title",
            "artists": [{"name": "My Artist", "id": "artist1"}],
            "album": {
                "name": "My Album",
                "id": "album1",
                "release_date": "2023-06-15",
                "images": [{"url": "http://img", "width": 640}],
            },
            "popularity": 72,
            "explicit": False,
            "external_ids": {"isrc": "USRC1234"},
            "duration_ms": 240000,
        }
        mock_album = {"label": "My Label"}
        mock_artist = {"genres": ["house", "deep house"]}

        with patch("djtoolkit.enrichment.spotify_lookup.spotipy") as mock_sp_mod:
            mock_sp = MagicMock()
            mock_sp_mod.Spotify.return_value = mock_sp
            mock_sp.search.return_value = {"tracks": {"items": [mock_track]}}
            mock_sp.album.return_value = mock_album
            mock_sp.artist.return_value = mock_artist

            result = lookup_track("My Artist", "My Title",
                                  client_id="cid", client_secret="csec")

        assert result is not None
        assert result["spotify_uri"] == "spotify:track:abc123"
        assert result["album"] == "My Album"
        assert result["record_label"] == "My Label"
        assert result["genres"] == "house, deep house"
        assert result["year"] == 2023
        assert result["release_date"] == "2023-06-15"
        assert result["popularity"] == 72
        assert result["explicit"] is False
        assert result["isrc"] == "USRC1234"
        assert result["duration_ms"] == 240000

    def test_filters_by_duration_tolerance(self):
        mock_track = {
            "uri": "spotify:track:abc123",
            "name": "Title",
            "artists": [{"name": "Artist", "id": "a1"}],
            "album": {"name": "Alb", "id": "al1", "release_date": "2023",
                       "images": []},
            "popularity": 50,
            "explicit": False,
            "external_ids": {},
            "duration_ms": 300000,  # 5 min — way off from 240000
        }
        with patch("djtoolkit.enrichment.spotify_lookup.spotipy") as mock_sp_mod:
            mock_sp = MagicMock()
            mock_sp_mod.Spotify.return_value = mock_sp
            mock_sp.search.return_value = {"tracks": {"items": [mock_track]}}

            # duration_ms=240000, tolerance default 30000 → 300000 is 60000 off
            result = lookup_track("Artist", "Title", duration_ms=240000,
                                  client_id="cid", client_secret="csec")

        assert result is None

    def test_fuzzy_match_rejects_low_score(self):
        mock_track = {
            "uri": "spotify:track:abc123",
            "name": "Completely Different Song",
            "artists": [{"name": "Other Artist", "id": "a1"}],
            "album": {"name": "Alb", "id": "al1", "release_date": "2023",
                       "images": []},
            "popularity": 50,
            "explicit": False,
            "external_ids": {},
            "duration_ms": 240000,
        }
        with patch("djtoolkit.enrichment.spotify_lookup.spotipy") as mock_sp_mod:
            mock_sp = MagicMock()
            mock_sp_mod.Spotify.return_value = mock_sp
            mock_sp.search.return_value = {"tracks": {"items": [mock_track]}}

            result = lookup_track("My Artist", "My Title",
                                  client_id="cid", client_secret="csec")

        assert result is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/cpecile/Code/djtoolkit && poetry run pytest tests/test_spotify_lookup.py -v`
Expected: FAIL with `ModuleNotFoundError` or `ImportError`

- [ ] **Step 3: Write implementation**

```python
# djtoolkit/enrichment/spotify_lookup.py
"""Single-track Spotify metadata lookup via API search.

Uses spotipy (Client Credentials flow) to search by artist+title,
fuzzy-match the best result, and extract metadata for DB storage.

Requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET in .env.
"""

from __future__ import annotations

import logging
import re

import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
from thefuzz import fuzz

log = logging.getLogger(__name__)

_CLEANUP_RE = re.compile(r"[^\w\s]")
_MIN_FUZZY_SCORE = 70
_DURATION_TOLERANCE_MS = 30_000


def _normalize(text: str) -> str:
    return _CLEANUP_RE.sub("", (text or "").lower()).strip()


def _year_from_release_date(release_date: str) -> int | None:
    if release_date and len(release_date) >= 4:
        try:
            return int(release_date[:4])
        except ValueError:
            pass
    return None


def lookup_track(
    artist: str,
    title: str,
    *,
    duration_ms: int | None = None,
    client_id: str = "",
    client_secret: str = "",
    spotify_uri: str | None = None,
) -> dict | None:
    """Look up a track on Spotify and return metadata dict, or None.

    If spotify_uri is provided, does a direct lookup instead of searching.
    Otherwise searches by artist+title and fuzzy-matches.

    Returns dict with keys: spotify_uri, album, release_date, year, genres,
    record_label, popularity, explicit, isrc, duration_ms.
    """
    if not client_id or not client_secret:
        log.debug("Spotify lookup skipped — no credentials")
        return None

    try:
        sp = spotipy.Spotify(
            auth_manager=SpotifyClientCredentials(
                client_id=client_id,
                client_secret=client_secret,
            )
        )
    except Exception as exc:
        log.warning("Spotify auth failed: %s", exc)
        return None

    # Direct lookup if URI provided
    if spotify_uri:
        try:
            track = sp.track(spotify_uri)
            return _extract_metadata(sp, track)
        except Exception as exc:
            log.warning("Spotify track lookup failed for %s: %s", spotify_uri, exc)
            return None

    # Search by artist + title
    query = f'artist:"{artist}" track:"{title}"'
    try:
        results = sp.search(q=query, type="track", limit=5)
    except Exception as exc:
        log.warning("Spotify search failed: %s", exc)
        return None

    items = results.get("tracks", {}).get("items", [])
    if not items:
        log.debug("No Spotify results for: %s", query)
        return None

    # Score and filter
    artist_norm = _normalize(artist)
    title_norm = _normalize(title)
    best_track = None
    best_score = 0

    for item in items:
        # Duration filter
        if duration_ms is not None:
            item_dur = item.get("duration_ms", 0)
            if abs(item_dur - duration_ms) > _DURATION_TOLERANCE_MS:
                continue

        item_artist = _normalize(
            item.get("artists", [{}])[0].get("name", "")
        )
        item_title = _normalize(item.get("name", ""))

        score = (
            fuzz.token_sort_ratio(artist_norm, item_artist)
            + fuzz.token_sort_ratio(title_norm, item_title)
        ) / 2

        if score > best_score:
            best_score = score
            best_track = item

    if best_score < _MIN_FUZZY_SCORE or best_track is None:
        log.debug("No match above threshold (best=%.0f) for: %s - %s",
                   best_score, artist, title)
        return None

    return _extract_metadata(sp, best_track)


def _extract_metadata(sp: spotipy.Spotify, track: dict) -> dict:
    """Extract metadata from a Spotify track object + album/artist lookups."""
    album_obj = track.get("album", {})
    artists = track.get("artists", [])
    release_date = album_obj.get("release_date", "")

    result = {
        "spotify_uri": track.get("uri"),
        "album": album_obj.get("name"),
        "release_date": release_date,
        "year": _year_from_release_date(release_date),
        "popularity": track.get("popularity"),
        "explicit": track.get("explicit", False),
        "isrc": track.get("external_ids", {}).get("isrc"),
        "duration_ms": track.get("duration_ms"),
    }

    # Fetch record_label from album
    album_id = album_obj.get("id")
    if album_id:
        try:
            full_album = sp.album(album_id)
            result["record_label"] = full_album.get("label")
        except Exception as exc:
            log.debug("Album lookup failed: %s", exc)

    # Fetch genres from primary artist
    if artists and artists[0].get("id"):
        try:
            full_artist = sp.artist(artists[0]["id"])
            genres = full_artist.get("genres", [])
            if genres:
                result["genres"] = ", ".join(genres)
        except Exception as exc:
            log.debug("Artist lookup failed: %s", exc)

    return result
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/cpecile/Code/djtoolkit && poetry run pytest tests/test_spotify_lookup.py -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/enrichment/spotify_lookup.py tests/test_spotify_lookup.py
git commit -m "feat: add spotify_lookup module for single-track API search"
```

---

### Task 2: Extract `analyze_single()` from audio_analysis.py

**Files:**
- Modify: `djtoolkit/enrichment/audio_analysis.py:242-289`
- Create: `tests/test_audio_analysis.py`

- [ ] **Step 1: Write failing test**

```python
# tests/test_audio_analysis.py
"""Tests for audio_analysis.analyze_single()."""

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import numpy as np
import pytest

from djtoolkit.enrichment.audio_analysis import analyze_single


def _build_librosa_mock():
    """Build a comprehensive librosa mock that works with both
    `import librosa` and `__import__("librosa")` patterns."""
    mock_lr = MagicMock()
    mock_lr.load.return_value = (
        np.random.randn(44100 * 10).astype(np.float32),
        44100,
    )
    mock_lr.beat.beat_track.return_value = (
        np.array([120.0]),
        np.array([0, 22050, 44100, 66150, 88200]),
    )
    mock_lr.feature.chroma_cqt.return_value = np.random.rand(12, 100)
    mock_lr.feature.rms.return_value = np.array([[0.1]])
    mock_lr.amplitude_to_db.return_value = np.array([-20.0])
    mock_lr.feature.spectral_centroid.return_value = np.array([[2000.0]])
    mock_lr.onset.onset_detect.return_value = np.array([0, 1, 2, 3, 4])
    return mock_lr


class TestAnalyzeSingle:
    def test_returns_all_feature_keys(self, tmp_path):
        dummy_file = tmp_path / "test.mp3"
        dummy_file.write_bytes(b"\x00" * 100)

        mock_lr = _build_librosa_mock()
        mock_pyln = MagicMock()
        mock_meter = MagicMock()
        mock_meter.integrated_loudness.return_value = -8.5
        mock_pyln.Meter.return_value = mock_meter

        # Patch sys.modules so both `import librosa` and `__import__("librosa")` resolve
        with patch.dict(sys.modules, {"librosa": mock_lr, "pyloudnorm": mock_pyln}):
            result = analyze_single(dummy_file)

        assert set(result.keys()) == {"tempo", "key", "mode", "danceability", "energy", "loudness"}
        assert isinstance(result["tempo"], float)
        assert 0 <= result["key"] <= 11
        assert result["mode"] in (0, 1)
        assert 0.0 <= result["danceability"] <= 1.0
        assert 0.0 <= result["energy"] <= 1.0
        assert isinstance(result["loudness"], float)

    def test_raises_on_missing_file(self):
        with pytest.raises(FileNotFoundError):
            analyze_single(Path("/nonexistent/file.mp3"))
```

**Note:** We patch `sys.modules` instead of individual attributes because `_danceability()` and `_energy()` use `__import__("librosa")` which bypasses normal attribute-level mocking.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/cpecile/Code/djtoolkit && poetry run pytest tests/test_audio_analysis.py -v`
Expected: FAIL with `ImportError` (analyze_single doesn't exist yet)

- [ ] **Step 3: Extract `analyze_single()` in `audio_analysis.py`**

Add a top-level lazy-import reference and the new function. Modify the file as follows:

Add the new public function before `run()` (before line 130). Uses local imports to avoid interfering with `run()`'s own import pattern:

```python
def analyze_single(path: Path) -> dict:
    """Run fast audio features on a single file. Returns feature dict.

    Handles its own imports (librosa, pyloudnorm) so it can be called
    independently of run(). Raises FileNotFoundError if path doesn't exist.

    Returns dict with keys: tempo, key, mode, danceability, energy, loudness.
    """
    import librosa

    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

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
```

Then refactor the Phase 3 loop body in `run()` (lines 250-288) to call `analyze_single()`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/cpecile/Code/djtoolkit && poetry run pytest tests/test_audio_analysis.py -v`
Expected: All PASS

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `cd /Users/cpecile/Code/djtoolkit && poetry run pytest tests/ -v`
Expected: All existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add djtoolkit/enrichment/audio_analysis.py tests/test_audio_analysis.py
git commit -m "refactor: extract analyze_single() from audio_analysis for agent use"
```

---

### Task 3: Add new job type handlers to agent executor

**Files:**
- Modify: `djtoolkit/agent/executor.py:103-117` (job dispatch), `278-308` (cover_art fix)

- [ ] **Step 1: Add `spotify_lookup` and `audio_analysis` to the dispatch match**

In `djtoolkit/agent/executor.py`, modify `execute_job` (line 107):

```python
async def execute_job(
    job_type: str, payload: dict, cfg: Config, credentials: dict,
) -> dict[str, Any]:
    """Dispatch a job to the appropriate executor. Returns result dict."""
    match job_type:
        case "download":
            return await execute_download(payload, cfg, credentials)
        case "fingerprint":
            return await execute_fingerprint(payload, cfg, credentials)
        case "spotify_lookup":
            return await execute_spotify_lookup(payload, cfg)
        case "cover_art":
            return await execute_cover_art(payload, cfg, credentials)
        case "audio_analysis":
            return await execute_audio_analysis(payload, cfg)
        case "metadata":
            return await execute_metadata(payload, cfg)
        case _:
            raise ValueError(f"Unsupported job type: {job_type}")
```

- [ ] **Step 2: Add `execute_spotify_lookup` handler**

Add after the fingerprint handler section in `executor.py`:

```python
# ─── Spotify Lookup ─────────────────────────────────────────────────────

async def execute_spotify_lookup(
    payload: dict, cfg: Config,
) -> dict[str, Any]:
    """Search Spotify for track metadata.

    Returns metadata dict on match, or {"matched": False} on no match.
    """
    from djtoolkit.enrichment.spotify_lookup import lookup_track

    artist = payload.get("artist", "")
    title = payload.get("title", "")
    duration_ms = payload.get("duration_ms")
    spotify_uri = payload.get("spotify_uri")

    ca = cfg.cover_art
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None, lambda: lookup_track(
            artist, title,
            duration_ms=duration_ms,
            client_id=ca.spotify_client_id,
            client_secret=ca.spotify_client_secret,
            spotify_uri=spotify_uri,
        )
    )

    if result is None:
        return {"matched": False}
    return result
```

- [ ] **Step 3: Add `execute_audio_analysis` handler**

Add after the spotify_lookup handler:

```python
# ─── Audio Analysis ─────────────────────────────────────────────────────

async def execute_audio_analysis(
    payload: dict, cfg: Config,
) -> dict[str, Any]:
    """Run BPM/key/energy/danceability/loudness analysis on a local file.

    Returns feature dict.
    """
    from djtoolkit.enrichment.audio_analysis import analyze_single

    local_path = Path(payload["local_path"])
    if not local_path.is_file():
        raise FileNotFoundError(f"File not found: {local_path}")

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, analyze_single, local_path)
```

- [ ] **Step 4: Fix `execute_cover_art` to pass `spotify_uri` and credentials**

Replace the existing `execute_cover_art` (lines 278-308) with:

```python
# ─── Cover Art ───────────────────────────────────────────────────────────

async def execute_cover_art(
    payload: dict, cfg: Config, credentials: dict,
) -> dict[str, Any]:
    """Fetch and embed cover art for a track.

    Returns {"cover_art_written": bool}.
    """
    from functools import partial
    from djtoolkit.coverart.art import _fetch_art, _embed

    local_path = Path(payload["local_path"])
    if not local_path.is_file():
        raise FileNotFoundError(f"File not found: {local_path}")

    artist = payload.get("artist", "")
    album = payload.get("album", "")
    title = payload.get("title", "")
    spotify_uri = payload.get("spotify_uri")

    ca = cfg.cover_art
    sources = [s.strip() for s in ca.sources.split() if s.strip()]

    fetch_fn = partial(
        _fetch_art, artist, album, title, sources,
        spotify_uri=spotify_uri,
        spotify_client_id=ca.spotify_client_id,
        spotify_client_secret=ca.spotify_client_secret,
        lastfm_api_key=ca.lastfm_api_key,
    )

    loop = asyncio.get_running_loop()
    art_bytes = await loop.run_in_executor(None, fetch_fn)

    if not art_bytes:
        return {"cover_art_written": False}

    await loop.run_in_executor(None, _embed, local_path, art_bytes)
    return {"cover_art_written": True}
```

- [ ] **Step 5: Run existing tests**

Run: `cd /Users/cpecile/Code/djtoolkit && poetry run pytest tests/ -v`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add djtoolkit/agent/executor.py
git commit -m "feat: add spotify_lookup + audio_analysis handlers; fix cover_art kwargs"
```

---

### Task 3b: Update `runner.py` and `agent/jobs/` modules

**Files:**
- Modify: `djtoolkit/agent/runner.py:65-75`
- Create: `djtoolkit/agent/jobs/spotify_lookup.py`
- Create: `djtoolkit/agent/jobs/audio_analysis.py`
- Modify: `djtoolkit/agent/jobs/cover_art.py`

The agent has two dispatch paths: `daemon.py` → `executor.py` (updated in Task 3) and `runner.py` → `agent/jobs/` modules. Both must handle the new job types.

- [ ] **Step 1: Create `agent/jobs/spotify_lookup.py`**

```python
# djtoolkit/agent/jobs/spotify_lookup.py
"""Agent job: look up track metadata on Spotify.

Payload fields:
  artist       str
  title        str
  duration_ms  int | None
  spotify_uri  str | None  — if already known, skip search
"""

from __future__ import annotations

import asyncio
import logging

from djtoolkit.config import Config

log = logging.getLogger(__name__)


async def run(cfg: Config, payload: dict) -> dict:
    """Search Spotify for track metadata. Returns metadata dict or {matched: False}."""
    from djtoolkit.enrichment.spotify_lookup import lookup_track

    artist = payload.get("artist", "")
    title = payload.get("title", "")
    duration_ms = payload.get("duration_ms")
    spotify_uri = payload.get("spotify_uri")

    ca = cfg.cover_art

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None, lambda: lookup_track(
            artist, title,
            duration_ms=duration_ms,
            client_id=ca.spotify_client_id,
            client_secret=ca.spotify_client_secret,
            spotify_uri=spotify_uri,
        )
    )

    if result is None:
        return {"matched": False}
    return result
```

- [ ] **Step 2: Create `agent/jobs/audio_analysis.py`**

```python
# djtoolkit/agent/jobs/audio_analysis.py
"""Agent job: run audio analysis on a local file.

Payload fields:
  local_path   str  — absolute path to the audio file
  track_id     int
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from djtoolkit.config import Config

log = logging.getLogger(__name__)


async def run(cfg: Config, payload: dict) -> dict:
    """Run BPM/key/energy/danceability/loudness analysis. Returns feature dict."""
    from djtoolkit.enrichment.audio_analysis import analyze_single

    local_path = Path(payload["local_path"])
    if not local_path.is_file():
        raise FileNotFoundError(f"File not found: {local_path}")

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, analyze_single, local_path)
```

- [ ] **Step 3: Fix `agent/jobs/cover_art.py` to use correct imports + credentials**

Replace the entire contents of `djtoolkit/agent/jobs/cover_art.py`:

```python
# djtoolkit/agent/jobs/cover_art.py
"""Agent job: fetch and embed cover art into a local audio file.

Payload fields:
  local_path   str  — absolute path to the audio file
  artist       str
  album        str
  title        str  (optional, used as fallback search term)
  spotify_uri  str | None
"""

from __future__ import annotations

import asyncio
import logging
from functools import partial
from pathlib import Path

from djtoolkit.config import Config

log = logging.getLogger(__name__)


async def run(cfg: Config, payload: dict) -> dict:
    """Fetch + embed cover art. Returns {cover_art_written: bool}."""
    from djtoolkit.coverart.art import _fetch_art, _embed

    local_path = Path(payload.get("local_path", ""))
    if not local_path.exists():
        raise FileNotFoundError(f"File not found: {local_path}")

    artist = payload.get("artist", "")
    album = payload.get("album", "")
    title = payload.get("title", "")
    spotify_uri = payload.get("spotify_uri")

    ca = cfg.cover_art
    sources = [s.strip() for s in ca.sources.split() if s.strip()]

    fetch_fn = partial(
        _fetch_art, artist, album, title, sources,
        spotify_uri=spotify_uri,
        spotify_client_id=ca.spotify_client_id,
        spotify_client_secret=ca.spotify_client_secret,
        lastfm_api_key=ca.lastfm_api_key,
    )

    loop = asyncio.get_running_loop()
    art_bytes = await loop.run_in_executor(None, fetch_fn)

    if not art_bytes:
        return {"cover_art_written": False}

    await loop.run_in_executor(None, _embed, local_path, art_bytes)
    return {"cover_art_written": True}
```

- [ ] **Step 4: Update dispatch match in `runner.py`**

In `djtoolkit/agent/runner.py`, add imports at the top (alongside existing job module imports):

```python
from djtoolkit.agent.jobs import spotify_lookup, audio_analysis
```

Replace the match block (lines 65-75):

```python
            match job_type:
                case "download":
                    result = await download.run(cfg, payload)
                case "fingerprint":
                    result = await fingerprint.run(cfg, payload)
                case "spotify_lookup":
                    result = await spotify_lookup.run(cfg, payload)
                case "cover_art":
                    result = await cover_art.run(cfg, payload)
                case "audio_analysis":
                    result = await audio_analysis.run(cfg, payload)
                case "metadata":
                    result = await metadata.run(cfg, payload)
                case _:
                    raise ValueError(f"Unknown job_type: {job_type!r}")
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/cpecile/Code/djtoolkit && poetry run pytest tests/ -v`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add djtoolkit/agent/jobs/spotify_lookup.py djtoolkit/agent/jobs/audio_analysis.py djtoolkit/agent/jobs/cover_art.py djtoolkit/agent/runner.py
git commit -m "feat: add agent job modules for spotify_lookup + audio_analysis; fix cover_art imports"
```

---

### Task 4: Branch pipeline chain in `job-result.ts`

**Files:**
- Modify: `web/lib/api-server/job-result.ts`

- [ ] **Step 0: Extract `buildMetadataPayload` helper**

The metadata payload construction logic (fetch track, build musicalKey, determine metadataSource) is needed in multiple cases. Add this helper function after the `hasActiveJob` function:

```typescript
/**
 * Fetch track state from DB and build the metadata job payload.
 * Returns null if track has no local_path.
 */
async function buildMetadataPayload(
  supabase: SupabaseClient,
  trackId: number,
  userId: string
): Promise<Record<string, unknown> | null> {
  const { data: trackRaw } = await supabase
    .from("tracks")
    .select(
      "local_path, title, artist, album, artists, year, release_date, " +
        "genres, record_label, isrc, tempo, key, mode, " +
        "duration_ms, enriched_spotify, enriched_audio"
    )
    .eq("id", trackId)
    .single();

  const track = trackRaw as Record<string, unknown> | null;
  if (!track?.local_path) return null;

  let musicalKey = "";
  if (track.key !== null && track.mode !== null) {
    const k = Number(track.key);
    if (k >= 0 && k < 12) {
      musicalKey = `${KEY_NAMES[k]}${Number(track.mode) === 0 ? "m" : ""}`;
    }
  }

  let metadataSource: string | null = null;
  if (track.enriched_spotify) {
    metadataSource = "spotify";
  } else if (track.enriched_audio) {
    metadataSource = "audio-analysis";
  }

  return {
    track_id: trackId,
    local_path: track.local_path as string,
    title: (track.title as string) ?? "",
    artist: (track.artist as string) ?? "",
    album: (track.album as string) ?? "",
    artists: (track.artists as string) ?? "",
    year: track.year,
    release_date: (track.release_date as string) ?? "",
    genres: (track.genres as string) ?? "",
    record_label: (track.record_label as string) ?? "",
    isrc: (track.isrc as string) ?? "",
    bpm: track.tempo,
    musical_key: musicalKey,
    duration_ms: track.duration_ms,
    metadata_source: metadataSource,
  };
}
```

- [ ] **Step 1: Update fingerprint case to branch on source**

In `web/lib/api-server/job-result.ts`, replace the "Auto-queue cover_art job" section inside the fingerprint case (lines 146-166) with:

```typescript
        // Auto-queue next job based on track source
        const { data: track } = await supabase
          .from("tracks")
          .select("local_path, artist, album, title, source, spotify_uri, duration_ms")
          .eq("id", trackId)
          .single();

        if (!track?.local_path) break;

        if (track.source === "exportify") {
          // Exportify tracks → cover_art (metadata from CSV already in DB)
          if (!(await hasActiveJob(supabase, trackId, "cover_art"))) {
            await supabase.from("pipeline_jobs").insert({
              user_id: userId,
              track_id: trackId,
              job_type: "cover_art",
              payload: {
                track_id: trackId,
                local_path: track.local_path,
                artist: track.artist ?? "",
                album: track.album ?? "",
                title: track.title ?? "",
                spotify_uri: track.spotify_uri ?? null,
              },
            });
          }
        } else {
          // Non-exportify tracks → spotify_lookup first
          if (!(await hasActiveJob(supabase, trackId, "spotify_lookup"))) {
            await supabase.from("pipeline_jobs").insert({
              user_id: userId,
              track_id: trackId,
              job_type: "spotify_lookup",
              payload: {
                track_id: trackId,
                artist: track.artist ?? "",
                title: track.title ?? "",
                duration_ms: track.duration_ms ?? null,
                spotify_uri: track.spotify_uri ?? null,
              },
            });
          }
        }
```

- [ ] **Step 2: Add `spotify_lookup` case**

Add before the `cover_art` case:

```typescript
    case "spotify_lookup": {
      // Write metadata to tracks table (if match found)
      if (result.matched !== false) {
        const updates: Record<string, unknown> = {
          enriched_spotify: true,
          updated_at: new Date().toISOString(),
        };
        // Copy all non-null metadata fields
        for (const col of [
          "spotify_uri", "album", "release_date", "year", "genres",
          "record_label", "popularity", "explicit", "isrc", "duration_ms",
        ]) {
          if (result[col] !== undefined && result[col] !== null) {
            updates[col] = result[col];
          }
        }
        await supabase
          .from("tracks")
          .update(updates)
          .eq("id", trackId)
          .eq("user_id", userId);
      }

      // Always queue cover_art (even on no-match — falls back to other sources)
      const { data: track } = await supabase
        .from("tracks")
        .select("local_path, artist, album, title, spotify_uri")
        .eq("id", trackId)
        .single();

      if (track?.local_path && !(await hasActiveJob(supabase, trackId, "cover_art"))) {
        await supabase.from("pipeline_jobs").insert({
          user_id: userId,
          track_id: trackId,
          job_type: "cover_art",
          payload: {
            track_id: trackId,
            local_path: track.local_path,
            artist: track.artist ?? "",
            album: track.album ?? "",
            title: track.title ?? "",
            spotify_uri: track.spotify_uri ?? null,
          },
        });
      }

      break;
    }
```

- [ ] **Step 3: Update `cover_art` case to branch on source**

Replace the `cover_art` case (lines 172-241) with:

```typescript
    case "cover_art": {
      if (result.cover_art_written) {
        await supabase
          .from("tracks")
          .update({
            cover_art_written: true,
            cover_art_embedded_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", trackId)
          .eq("user_id", userId);
      }

      // Fetch track to determine source and build next job payload
      const { data: trackRaw } = await supabase
        .from("tracks")
        .select(
          "local_path, title, artist, album, artists, year, release_date, " +
            "genres, record_label, isrc, tempo, key, mode, " +
            "duration_ms, enriched_spotify, enriched_audio, source"
        )
        .eq("id", trackId)
        .single();

      const track = trackRaw as Record<string, unknown> | null;
      if (!track?.local_path) break;

      if (track.source !== "exportify") {
        // Non-exportify → queue audio_analysis
        if (!(await hasActiveJob(supabase, trackId, "audio_analysis"))) {
          await supabase.from("pipeline_jobs").insert({
            user_id: userId,
            track_id: trackId,
            job_type: "audio_analysis",
            payload: {
              track_id: trackId,
              local_path: track.local_path as string,
            },
          });
        }
      } else {
        // Exportify → queue metadata directly (uses shared helper)
        if (await hasActiveJob(supabase, trackId, "metadata")) break;
        const metaPayload = await buildMetadataPayload(supabase, trackId, userId);
        if (metaPayload) {
          await supabase.from("pipeline_jobs").insert({
            user_id: userId,
            track_id: trackId,
            job_type: "metadata",
            payload: metaPayload,
          });
        }
      }

      break;
    }
```

- [ ] **Step 4: Add `audio_analysis` case**

Add before the `metadata` case:

```typescript
    case "audio_analysis": {
      // Write audio features to tracks table
      const featureUpdates: Record<string, unknown> = {
        enriched_audio: true,
        updated_at: new Date().toISOString(),
      };
      for (const col of ["tempo", "key", "mode", "danceability", "energy", "loudness"]) {
        if (result[col] !== undefined && result[col] !== null) {
          featureUpdates[col] = result[col];
        }
      }
      await supabase
        .from("tracks")
        .update(featureUpdates)
        .eq("id", trackId)
        .eq("user_id", userId);

      // Queue metadata job (uses shared helper)
      if (await hasActiveJob(supabase, trackId, "metadata")) break;
      const metaPayload = await buildMetadataPayload(supabase, trackId, userId);
      if (metaPayload) {
        await supabase.from("pipeline_jobs").insert({
          user_id: userId,
          track_id: trackId,
          job_type: "metadata",
          payload: metaPayload,
        });
      }

      break;
    }
```

- [ ] **Step 5: Commit**

```bash
git add web/lib/api-server/job-result.ts
git commit -m "feat: branch pipeline chain by track source; add spotify_lookup + audio_analysis"
```

---

### Task 5: Handle `audio_analysis` failure → continue chain

**Files:**
- Modify: `web/lib/api-server/job-result.ts` (export `buildMetadataPayload`)
- Modify: `web/app/api/pipeline/jobs/[id]/result/route.ts:87-117`

- [ ] **Step 1: Export `buildMetadataPayload` from job-result.ts**

Add `export` keyword to the function definition added in Task 4 Step 0:

```typescript
export async function buildMetadataPayload(
```

- [ ] **Step 2: Add audio_analysis failure handler in result route**

In `web/app/api/pipeline/jobs/[id]/result/route.ts`, add the import at the top:

```typescript
import { applyJobResult, buildMetadataPayload } from "@/lib/api-server/job-result";
```

In the failure branch (after the download retry logic, around line 117), add:

```typescript
    } else if (body.status === "failed" && job.job_type === "audio_analysis") {
      // Audio analysis failed — still queue metadata so pipeline doesn't stall
      const { data: existing } = await supabase
        .from("pipeline_jobs")
        .select("id")
        .eq("track_id", job.track_id)
        .eq("job_type", "metadata")
        .in("status", ["pending", "claimed", "running"])
        .limit(1)
        .maybeSingle();

      if (!existing) {
        const metaPayload = await buildMetadataPayload(supabase, job.track_id, user.userId);
        if (metaPayload) {
          await supabase.from("pipeline_jobs").insert({
            user_id: user.userId,
            track_id: job.track_id,
            job_type: "metadata",
            payload: metaPayload,
          });
        }
      }
    }
```

- [ ] **Step 3: Commit**

```bash
git add web/lib/api-server/job-result.ts web/app/api/pipeline/jobs/[id]/result/route.ts
git commit -m "feat: continue pipeline chain on audio_analysis failure"
```

---

### Task 6: Update DOWNSTREAM map and LED tokens

**Files:**
- Modify: `web/app/api/pipeline/jobs/retry/route.ts:33-37`
- Modify: `web/lib/design-system/tokens.ts:145-149`

- [ ] **Step 1: Update DOWNSTREAM in retry route**

Replace lines 33-37 in `web/app/api/pipeline/jobs/retry/route.ts`:

```typescript
  const DOWNSTREAM: Record<string, string[]> = {
    download:       ["fingerprint", "spotify_lookup", "cover_art", "audio_analysis", "metadata"],
    fingerprint:    ["spotify_lookup", "cover_art", "audio_analysis", "metadata"],
    spotify_lookup: ["cover_art", "audio_analysis", "metadata"],
    cover_art:      ["audio_analysis", "metadata"],
    audio_analysis: ["metadata"],
  };
```

- [ ] **Step 2: Update JOB_TYPE_LED in tokens**

Replace lines 145-149 in `web/lib/design-system/tokens.ts`:

```typescript
export const JOB_TYPE_LED = {
  download: "blue",
  fingerprint: "green",
  spotify_lookup: "green",
  audio_analysis: "orange",
  cover_art: "blue",
  metadata: "orange",
  tag: "orange",
} as const;
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/cpecile/Code/djtoolkit/web && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add web/app/api/pipeline/jobs/retry/route.ts web/lib/design-system/tokens.ts
git commit -m "feat: update DOWNSTREAM map and LED colors for new job types"
```

---

### Task 7: End-to-end verification

- [ ] **Step 1: Run all Python tests**

Run: `cd /Users/cpecile/Code/djtoolkit && poetry run pytest tests/ -v`
Expected: All tests pass

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/cpecile/Code/djtoolkit/web && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Verify Next.js builds**

Run: `cd /Users/cpecile/Code/djtoolkit/web && npm run build`
Expected: Build succeeds

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A && git commit -m "fix: address build/test issues"
```
