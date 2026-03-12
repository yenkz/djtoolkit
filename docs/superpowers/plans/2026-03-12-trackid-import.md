# TrackID.dev Import Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Flow 3 — submit a YouTube DJ mix URL to TrackID.dev, poll for identified tracks, insert as `candidate` for Soulseek download.

**Architecture:** New `djtoolkit/importers/trackid.py` owns the full flow (URL validation, HTTP calls, cache check, DB insert). The DB gains a `trackid_jobs` cache table. Config gains a `[trackid]` section. A new CLI subcommand and Makefile target expose the flow.

**Tech Stack:** Python stdlib (`urllib.request`, `urllib.parse`, `re`, `time`), SQLite via existing `database.py` helpers, Rich for progress, Typer for CLI. No new dependencies.

---

## Chunk 1: DB + Config

### Task 1: Add `trackid_jobs` table to schema, migrate, and wipe

**Files:**
- Modify: `djtoolkit/db/schema.sql`
- Modify: `djtoolkit/db/database.py`
- Test: `tests/test_database.py`

- [ ] **Step 1.1: Write failing test for trackid_jobs table existence after setup()**

```python
# In tests/test_database.py — add at bottom of file

def test_setup_creates_trackid_jobs(tmp_path):
    db_path = tmp_path / "test.db"
    setup(db_path)
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='trackid_jobs'"
        ).fetchone()
    assert row is not None, "trackid_jobs table was not created by setup()"
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
poetry run pytest tests/test_database.py::test_setup_creates_trackid_jobs -v
```

Expected: FAIL — table does not exist yet.

- [ ] **Step 1.3: Add trackid_jobs to schema.sql**

Append after the `track_embeddings` table (end of file):

```sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trackid_jobs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    youtube_url    TEXT UNIQUE NOT NULL,  -- normalized canonical URL
    job_id         TEXT UNIQUE,           -- TrackID.dev job ID
    status         TEXT NOT NULL DEFAULT 'queued',
                                          -- queued | completed | failed
    tracks_found   INTEGER,               -- total tracks returned by API
    tracks_imported INTEGER,              -- tracks inserted into tracks table
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS trackid_jobs_updated_at
AFTER UPDATE ON trackid_jobs
BEGIN
    UPDATE trackid_jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
```

- [ ] **Step 1.4: Run test to verify it passes**

```bash
poetry run pytest tests/test_database.py::test_setup_creates_trackid_jobs -v
```

Expected: PASS.

- [ ] **Step 1.5: Write failing test for migrate() creating trackid_jobs on existing DB**

```python
def test_migrate_creates_trackid_jobs(tmp_path):
    """migrate() must create trackid_jobs even on a DB that predates it."""
    db_path = tmp_path / "old.db"
    # Create DB without trackid_jobs (simulate pre-feature DB)
    with connect(db_path) as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS tracks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                acquisition_status TEXT NOT NULL DEFAULT 'candidate',
                source TEXT NOT NULL
            );
        """)
        conn.commit()
    migrate(db_path)
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='trackid_jobs'"
        ).fetchone()
    assert row is not None, "migrate() did not create trackid_jobs"
```

- [ ] **Step 1.6: Run test to verify it fails**

```bash
poetry run pytest tests/test_database.py::test_migrate_creates_trackid_jobs -v
```

Expected: FAIL.

- [ ] **Step 1.7: Add trackid_jobs creation to migrate() in database.py**

After the existing column-addition logic in `migrate()`, before `conn.commit()`, add:

```python
        # Create trackid_jobs cache table if not present (idempotent)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS trackid_jobs (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                youtube_url    TEXT UNIQUE NOT NULL,
                job_id         TEXT UNIQUE,
                status         TEXT NOT NULL DEFAULT 'queued',
                tracks_found   INTEGER,
                tracks_imported INTEGER,
                created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TRIGGER IF NOT EXISTS trackid_jobs_updated_at
            AFTER UPDATE ON trackid_jobs
            BEGIN
                UPDATE trackid_jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
            END
        """)
```

- [ ] **Step 1.8: Run test to verify it passes**

```bash
poetry run pytest tests/test_database.py::test_migrate_creates_trackid_jobs -v
```

Expected: PASS.

- [ ] **Step 1.9: Write failing test for wipe() dropping trackid_jobs**

```python
def test_wipe_drops_trackid_jobs(tmp_path):
    db_path = tmp_path / "test.db"
    setup(db_path)
    # Insert a row so the table is populated
    with connect(db_path) as conn:
        conn.execute(
            "INSERT INTO trackid_jobs (youtube_url) VALUES (?)",
            ("https://www.youtube.com/watch?v=test123",)
        )
        conn.commit()
    wipe(db_path)
    # After wipe, table should exist (recreated by setup) but be empty
    with connect(db_path) as conn:
        count = conn.execute("SELECT COUNT(*) FROM trackid_jobs").fetchone()[0]
    assert count == 0
```

- [ ] **Step 1.10: Run test to verify it fails**

```bash
poetry run pytest tests/test_database.py::test_wipe_drops_trackid_jobs -v
```

Expected: FAIL — `wipe()` doesn't drop `trackid_jobs` yet, so the row persists.

- [ ] **Step 1.11: Add trackid_jobs to wipe() in database.py**

```python
def wipe(db_path: str | Path) -> None:
    """Drop all tables and recreate schema."""
    with connect(db_path) as conn:
        conn.executescript("""
            DROP TABLE IF EXISTS track_embeddings;
            DROP TABLE IF EXISTS fingerprints;
            DROP TABLE IF EXISTS trackid_jobs;
            DROP TABLE IF EXISTS tracks;
        """)
    setup(db_path)
```

- [ ] **Step 1.12: Run all database tests**

```bash
poetry run pytest tests/test_database.py -v
```

Expected: all PASS.

- [ ] **Step 1.13: Update source column comment in schema.sql**

Find the line:
```sql
source             TEXT    NOT NULL, -- 'exportify' | 'folder'
```

Change to:
```sql
source             TEXT    NOT NULL, -- 'exportify' | 'folder' | 'trackid'
```

- [ ] **Step 1.14: Commit**

```bash
git add djtoolkit/db/schema.sql djtoolkit/db/database.py tests/test_database.py
git commit -m "feat: add trackid_jobs table to schema, migrate, and wipe"
```

---

### Task 2: Add TrackIdConfig to config.py

**Files:**
- Modify: `djtoolkit/config.py`
- Modify: `djtoolkit.toml.example`
- Test: `tests/test_config.py`

- [ ] **Step 2.1: Write failing test for TrackIdConfig**

```python
# In tests/test_config.py — add at bottom

def test_trackid_defaults():
    from djtoolkit.config import TrackIdConfig
    cfg = TrackIdConfig()
    assert cfg.confidence_threshold == 0.7
    assert cfg.poll_interval_sec == 7
    assert cfg.poll_timeout_sec == 1800
    assert cfg.base_url == "https://trackid.dev"


def test_config_has_trackid_section(tmp_path):
    from djtoolkit.config import load
    cfg_path = tmp_path / "djtoolkit.toml"
    cfg_path.write_text("""
[trackid]
confidence_threshold = 0.5
poll_interval_sec = 5
""")
    cfg = load(cfg_path)
    assert cfg.trackid.confidence_threshold == 0.5
    assert cfg.trackid.poll_interval_sec == 5
    assert cfg.trackid.poll_timeout_sec == 1800  # default
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
poetry run pytest tests/test_config.py::test_trackid_defaults tests/test_config.py::test_config_has_trackid_section -v
```

Expected: FAIL — `TrackIdConfig` does not exist.

- [ ] **Step 2.3: Add TrackIdConfig dataclass and wire into Config and load()**

In `djtoolkit/config.py`, add the dataclass after `AgentConfig`:

```python
@dataclass
class TrackIdConfig:
    confidence_threshold: float = 0.7   # 0.0–1.0; tracks below this are skipped
    poll_interval_sec: int = 7          # seconds between status polls (clamped to 3–10 in poll_job)
    poll_timeout_sec: int = 1800        # max total poll duration in seconds; 0 = unlimited
    base_url: str = "https://trackid.dev"
```

In the `Config` dataclass, add the field:

```python
    trackid: TrackIdConfig = field(default_factory=TrackIdConfig)
```

In `load()`, the `_make` helper is defined **inside the `else` branch** (line ~161). The `cfg = Config(...)` call is also inside that `else` branch. Add `trackid` inside that same block:

```python
        cfg = Config(
            db=_make(DbConfig, "db"),
            # ... existing lines ...
            agent=_make(AgentConfig, "agent"),
            trackid=_make(TrackIdConfig, "trackid"),   # add this line
        )
```

Do NOT add it to the `if not path.exists(): cfg = Config()` branch — defaults apply there automatically via `field(default_factory=TrackIdConfig)`.

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
poetry run pytest tests/test_config.py::test_trackid_defaults tests/test_config.py::test_config_has_trackid_section -v
```

Expected: PASS.

- [ ] **Step 2.5: Add [trackid] section to djtoolkit.toml.example**

Find the `[agent]` section in `djtoolkit.toml.example` and append after it:

```toml
[trackid]
confidence_threshold = 0.7    # 0.0–1.0; tracks below this are skipped
poll_interval_sec = 7         # seconds between job status polls (clamped to 3–10 internally)
poll_timeout_sec = 1800       # max total poll time in seconds; 0 = unlimited
base_url = "https://trackid.dev"  # override for testing
```

- [ ] **Step 2.6: Run all config tests**

```bash
poetry run pytest tests/test_config.py -v
```

Expected: all PASS.

- [ ] **Step 2.7: Commit**

```bash
git add djtoolkit/config.py djtoolkit.toml.example tests/test_config.py
git commit -m "feat: add TrackIdConfig with confidence_threshold, poll settings"
```

---

## Chunk 2: Importer Module

### Task 3: validate_url()

**Files:**
- Create: `djtoolkit/importers/trackid.py`
- Create: `tests/test_trackid_importer.py`

- [ ] **Step 3.1: Write failing tests for validate_url**

Create `tests/test_trackid_importer.py`:

```python
"""Tests for TrackID.dev importer."""

import pytest
from djtoolkit.importers.trackid import validate_url


# ─── validate_url ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("url,expected", [
    # Standard watch URL
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Without www
    ("https://youtube.com/watch?v=dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Short URL
    ("https://youtu.be/dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Embed URL
    ("https://www.youtube.com/embed/dQw4w9WgXcQ",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Strips tracking params
    ("https://youtu.be/dQw4w9WgXcQ?si=abc123",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    # Strips extra params, keeps video ID
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&t=42",
     "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
])
def test_validate_url_normalizes(url, expected):
    assert validate_url(url) == expected


@pytest.mark.parametrize("bad_url", [
    "https://vimeo.com/123456",
    "https://soundcloud.com/artist/track",
    "not-a-url",
    "",
    "https://youtube.com/",           # no video ID
    "https://youtube.com/watch",      # no v= param
])
def test_validate_url_rejects_invalid(bad_url):
    with pytest.raises(ValueError):
        validate_url(bad_url)
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
poetry run pytest tests/test_trackid_importer.py::test_validate_url_normalizes tests/test_trackid_importer.py::test_validate_url_rejects_invalid -v
```

Expected: FAIL — module does not exist.

- [ ] **Step 3.3: Create trackid.py with validate_url**

Create `djtoolkit/importers/trackid.py`:

```python
"""Flow 3 — identify tracks in a YouTube DJ mix via TrackID.dev API."""

import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import json
from datetime import datetime, timezone

from djtoolkit.config import Config
from djtoolkit.db.database import connect
from djtoolkit.utils.search_string import build as build_search_string


# ─── Exceptions ───────────────────────────────────────────────────────────────

class PollTimeoutError(Exception):
    """Raised by poll_job() when poll_timeout_sec is exceeded."""


# ─── URL Validation ───────────────────────────────────────────────────────────

_YOUTUBE_ID_RE = re.compile(r'^[A-Za-z0-9_-]{11}$')


def _extract_video_id(url: str) -> str | None:
    """Return the 11-char YouTube video ID from a URL, or None if not found."""
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower().lstrip("www.")

    if host == "youtu.be":
        vid = parsed.path.lstrip("/").split("/")[0]
        if _YOUTUBE_ID_RE.match(vid):
            return vid

    if host in ("youtube.com", "m.youtube.com"):
        if parsed.path.startswith("/embed/"):
            vid = parsed.path[len("/embed/"):].split("/")[0]
            if _YOUTUBE_ID_RE.match(vid):
                return vid
        qs = urllib.parse.parse_qs(parsed.query)
        vid = qs.get("v", [None])[0]
        if vid and _YOUTUBE_ID_RE.match(vid):
            return vid

    return None


def validate_url(url: str) -> str:
    """Normalize and validate a YouTube URL.

    Accepts youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID.
    Strips tracking params. Returns canonical https://www.youtube.com/watch?v=ID.
    Raises ValueError if no valid YouTube video ID is found.
    """
    if not url:
        raise ValueError("URL must not be empty — expected a YouTube URL")
    vid = _extract_video_id(url)
    if not vid:
        raise ValueError(f"Not a valid YouTube URL (expected youtube.com/watch?v=ID, youtu.be/ID, or youtube.com/embed/ID): {url!r}")
    return f"https://www.youtube.com/watch?v={vid}"
```

- [ ] **Step 3.4: Run tests to verify they pass**

```bash
poetry run pytest tests/test_trackid_importer.py::test_validate_url_normalizes tests/test_trackid_importer.py::test_validate_url_rejects_invalid -v
```

Expected: all PASS.

- [ ] **Step 3.5: Commit**

```bash
git add djtoolkit/importers/trackid.py tests/test_trackid_importer.py
git commit -m "feat: add validate_url for YouTube URL normalization"
```

---

### Task 4: submit_job() and poll_job()

**Files:**
- Modify: `djtoolkit/importers/trackid.py`
- Modify: `tests/test_trackid_importer.py`

- [ ] **Step 4.1: Write failing tests for submit_job and poll_job**

Add to `tests/test_trackid_importer.py`:

```python
import json
from unittest.mock import patch, MagicMock
from djtoolkit.importers.trackid import submit_job, poll_job, PollTimeoutError
from djtoolkit.config import Config, TrackIdConfig


def _cfg(**kwargs) -> Config:
    cfg = Config()
    for k, v in kwargs.items():
        setattr(cfg.trackid, k, v)
    return cfg


def _mock_response(body: dict, status: int = 200):
    """Build a mock urllib response."""
    mock = MagicMock()
    mock.status = status
    mock.read.return_value = json.dumps(body).encode()
    mock.__enter__ = lambda s: s
    mock.__exit__ = MagicMock(return_value=False)
    return mock


# ─── submit_job ───────────────────────────────────────────────────────────────

def test_submit_job_returns_job_id():
    cfg = _cfg()
    mock_resp = _mock_response({"jobId": "job_123", "status": "queued"})
    with patch("urllib.request.urlopen", return_value=mock_resp):
        job_id = submit_job("https://www.youtube.com/watch?v=abc", cfg)
    assert job_id == "job_123"


def test_submit_job_retries_on_429():
    cfg = _cfg()
    ok_resp = _mock_response({"jobId": "job_456", "status": "queued"})
    err_429 = urllib.error.HTTPError(
        url=None, code=429, msg="Too Many Requests", hdrs=None, fp=None
    )
    with patch("urllib.request.urlopen", side_effect=[err_429, ok_resp]), \
         patch("time.sleep"):
        job_id = submit_job("https://www.youtube.com/watch?v=abc", cfg)
    assert job_id == "job_456"


def test_submit_job_raises_after_max_retries():
    cfg = _cfg()
    err_429 = urllib.error.HTTPError(
        url=None, code=429, msg="Too Many Requests", hdrs=None, fp=None
    )
    with patch("urllib.request.urlopen", side_effect=[err_429, err_429, err_429, err_429]), \
         patch("time.sleep"):
        with pytest.raises(RuntimeError, match="Rate limited"):
            submit_job("https://www.youtube.com/watch?v=abc", cfg)


# ─── poll_job ─────────────────────────────────────────────────────────────────

def test_poll_job_returns_on_completed():
    cfg = _cfg(poll_interval_sec=1, poll_timeout_sec=60)
    completed = {
        "id": "job_123",
        "status": "completed",
        "tracks": [
            {"id": "t1", "timestamp": 0, "duration": 180,
             "artist": "Bonobo", "title": "Kong",
             "confidence": 0.95, "acoustidId": "aid1",
             "youtubeUrl": "", "isUnknown": False}
        ]
    }
    mock_resp = _mock_response(completed)
    with patch("urllib.request.urlopen", return_value=mock_resp), \
         patch("time.sleep"):
        result = poll_job("job_123", cfg)
    assert result["status"] == "completed"
    assert len(result["tracks"]) == 1


def test_poll_job_raises_on_api_failed():
    cfg = _cfg(poll_interval_sec=1, poll_timeout_sec=60)
    failed = {"id": "job_123", "status": "failed"}
    mock_resp = _mock_response(failed)
    with patch("urllib.request.urlopen", return_value=mock_resp), \
         patch("time.sleep"):
        with pytest.raises(RuntimeError, match="failed"):
            poll_job("job_123", cfg)


def test_poll_job_raises_on_timeout():
    cfg = _cfg(poll_interval_sec=3, poll_timeout_sec=1)
    in_progress = {"id": "job_123", "status": "fingerprinting", "progress": 50}
    mock_resp = _mock_response(in_progress)
    with patch("urllib.request.urlopen", return_value=mock_resp), \
         patch("time.sleep"), \
         patch("time.monotonic", side_effect=[0.0, 0.0, 2.0]):  # start, check, elapsed > timeout
        with pytest.raises(PollTimeoutError):
            poll_job("job_123", cfg)
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
poetry run pytest tests/test_trackid_importer.py -k "submit_job or poll_job" -v
```

Expected: FAIL — functions not yet defined.

- [ ] **Step 4.3: Implement submit_job and poll_job in trackid.py**

Add after `validate_url`:

```python
# ─── HTTP helpers ─────────────────────────────────────────────────────────────

_USER_AGENT = "djtoolkit/1.0"
_MAX_RETRIES = 3
_BACKOFF_START = 15  # seconds


def _http_get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _http_post(url: str, body: dict) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"User-Agent": _USER_AGENT, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _with_backoff(fn, *args, **kwargs):
    """Call fn(*args, **kwargs), retrying up to _MAX_RETRIES on HTTP 429."""
    delay = _BACKOFF_START
    for attempt in range(_MAX_RETRIES + 1):
        try:
            return fn(*args, **kwargs)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < _MAX_RETRIES:
                time.sleep(delay)
                delay *= 2
                continue
            if e.code == 429:
                raise RuntimeError(
                    f"Rate limited by TrackID.dev after {_MAX_RETRIES} retries"
                ) from e
            raise


# ─── API calls ────────────────────────────────────────────────────────────────

def submit_job(url: str, cfg: Config) -> str:
    """POST to /api/analyze and return the jobId string."""
    endpoint = f"{cfg.trackid.base_url}/api/analyze"
    result = _with_backoff(_http_post, endpoint, {"url": url})
    return result["jobId"]


def poll_job(job_id: str, cfg: Config) -> dict:
    """Poll /api/job/{jobId} until completed; return the job dict.

    Raises:
        PollTimeoutError: if poll_timeout_sec is exceeded (0 = unlimited).
        RuntimeError: if the API reports status 'failed'.
    """
    from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn

    interval = max(3, min(10, cfg.trackid.poll_interval_sec))
    timeout = cfg.trackid.poll_timeout_sec  # 0 = unlimited
    endpoint = f"{cfg.trackid.base_url}/api/job/{job_id}"
    start = time.monotonic()

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.percentage:>3.0f}%"),
        transient=True,
    ) as progress:
        task = progress.add_task("Waiting for TrackID.dev…", total=100)

        while True:
            if timeout and (time.monotonic() - start) >= timeout:
                raise PollTimeoutError(
                    f"TrackID.dev job {job_id!r} timed out after {timeout}s"
                )

            try:
                data = _with_backoff(_http_get, endpoint)
            except urllib.error.URLError:
                # Network error — retry up to 3 times with 10s wait
                for _ in range(3):
                    time.sleep(10)
                    try:
                        data = _with_backoff(_http_get, endpoint)
                        break
                    except urllib.error.URLError:
                        pass
                else:
                    raise RuntimeError(
                        f"Network error polling TrackID.dev job {job_id!r}"
                    )

            status = data.get("status", "")
            step = data.get("currentStep", status)
            pct = data.get("progress", 0)

            progress.update(task, description=step, completed=pct)

            if status == "completed":
                return data
            if status == "failed":
                raise RuntimeError(
                    f"TrackID.dev job {job_id!r} failed on the server"
                )

            time.sleep(interval)
```

- [ ] **Step 4.4: Run tests to verify they pass**

```bash
poetry run pytest tests/test_trackid_importer.py -k "submit_job or poll_job" -v
```

Expected: all PASS.

- [ ] **Step 4.5: Commit**

```bash
git add djtoolkit/importers/trackid.py tests/test_trackid_importer.py
git commit -m "feat: add submit_job and poll_job for TrackID.dev API"
```

---

### Task 5: import_trackid() orchestration

**Files:**
- Modify: `djtoolkit/importers/trackid.py`
- Modify: `tests/test_trackid_importer.py`

- [ ] **Step 5.1: Write failing integration tests for import_trackid**

Add to `tests/test_trackid_importer.py`:

```python
from djtoolkit.importers.trackid import import_trackid
from djtoolkit.db.database import setup, connect


@pytest.fixture
def db(tmp_path):
    db_path = tmp_path / "test.db"
    setup(db_path)
    return db_path


def _job_completed(tracks: list) -> dict:
    return {"id": "job_abc", "status": "completed", "tracks": tracks}


_track_counter = 0

def _make_track(artist="Bonobo", title="Kong", confidence=0.95,
                duration=180, is_unknown=False):
    global _track_counter
    _track_counter += 1
    return {
        "id": f"t{_track_counter}", "timestamp": 0, "duration": duration,
        "artist": artist, "title": title, "confidence": confidence,
        "acoustidId": f"aid{_track_counter}", "youtubeUrl": "", "isUnknown": is_unknown,
    }


def test_import_trackid_inserts_tracks(db, tmp_path):
    cfg = _cfg()
    cfg.db.path = str(db)
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    completed = _job_completed([_make_track(), _make_track("Aphex Twin", "Windowlicker", 0.88)])

    with patch("djtoolkit.importers.trackid.submit_job", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_job", return_value=completed):
        stats = import_trackid(url, cfg)

    assert stats["imported"] == 2
    assert stats["skipped_low_confidence"] == 0
    assert stats["skipped_unknown"] == 0
    with connect(db) as conn:
        rows = conn.execute("SELECT * FROM tracks").fetchall()
    assert len(rows) == 2
    assert rows[0]["source"] == "trackid"
    assert rows[0]["acquisition_status"] == "candidate"
    assert rows[0]["duration_ms"] == 180 * 1000


def test_import_trackid_filters_low_confidence(db):
    cfg = _cfg()
    cfg.db.path = str(db)
    cfg.trackid.confidence_threshold = 0.8
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    completed = _job_completed([
        _make_track(confidence=0.9),   # passes
        _make_track("Low", "Score", confidence=0.5),  # filtered
    ])

    with patch("djtoolkit.importers.trackid.submit_job", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_job", return_value=completed):
        stats = import_trackid(url, cfg)

    assert stats["imported"] == 1
    assert stats["skipped_low_confidence"] == 1


def test_import_trackid_filters_unknown(db):
    cfg = _cfg()
    cfg.db.path = str(db)
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    completed = _job_completed([
        _make_track(),
        _make_track(is_unknown=True),
    ])

    with patch("djtoolkit.importers.trackid.submit_job", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_job", return_value=completed):
        stats = import_trackid(url, cfg)

    assert stats["imported"] == 1
    assert stats["skipped_unknown"] == 1


def test_import_trackid_cache_skips_duplicate_url(db):
    cfg = _cfg()
    cfg.db.path = str(db)
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    completed = _job_completed([_make_track()])

    with patch("djtoolkit.importers.trackid.submit_job", return_value="job_abc") as mock_submit, \
         patch("djtoolkit.importers.trackid.poll_job", return_value=completed):
        import_trackid(url, cfg)
        stats = import_trackid(url, cfg)

    # submit_job called only once — cache skipped on second call
    assert mock_submit.call_count == 1
    assert "cached" in stats or stats.get("skipped_cached") == 1


def test_import_trackid_force_bypasses_cache(db):
    cfg = _cfg()
    cfg.db.path = str(db)
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    completed = _job_completed([_make_track()])

    with patch("djtoolkit.importers.trackid.submit_job", return_value="job_abc") as mock_submit, \
         patch("djtoolkit.importers.trackid.poll_job", return_value=completed):
        import_trackid(url, cfg)
        import_trackid(url, cfg, force=True)

    assert mock_submit.call_count == 2


def test_import_trackid_empty_tracks(db):
    cfg = _cfg()
    cfg.db.path = str(db)
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    completed = _job_completed([])

    with patch("djtoolkit.importers.trackid.submit_job", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_job", return_value=completed):
        stats = import_trackid(url, cfg)

    assert stats["identified"] == 0
    assert stats["imported"] == 0


def test_import_trackid_records_job_in_cache(db):
    cfg = _cfg()
    cfg.db.path = str(db)
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    completed = _job_completed([_make_track()])

    with patch("djtoolkit.importers.trackid.submit_job", return_value="job_abc"), \
         patch("djtoolkit.importers.trackid.poll_job", return_value=completed):
        import_trackid(url, cfg)

    with connect(db) as conn:
        row = conn.execute("SELECT * FROM trackid_jobs WHERE youtube_url = ?", (url,)).fetchone()
    assert row is not None
    assert row["status"] == "completed"
    assert row["tracks_imported"] == 1
```

- [ ] **Step 5.2: Run tests to verify they fail**

```bash
poetry run pytest tests/test_trackid_importer.py -k "import_trackid" -v
```

Expected: FAIL — `import_trackid` not yet defined.

- [ ] **Step 5.3: Implement import_trackid in trackid.py**

Add at the bottom of `djtoolkit/importers/trackid.py`:

```python
# ─── Main entry point ─────────────────────────────────────────────────────────

def import_trackid(url: str, cfg: Config, force: bool = False) -> dict:
    """Full Flow 3 orchestration.

    Validates URL, checks cache, submits to TrackID.dev, polls for results,
    filters by confidence, inserts candidates into DB, and records job in cache.

    Returns stats dict with keys:
        identified, imported, skipped_low_confidence, skipped_unknown,
        failed, skipped_cached.
    """
    stats = {
        "identified": 0,
        "imported": 0,
        "skipped_low_confidence": 0,
        "skipped_unknown": 0,
        "failed": 0,
        "skipped_cached": 0,
    }

    # 1. Validate + normalize URL
    normalized_url = validate_url(url)

    with connect(cfg.db_path) as conn:
        # 2. Check cache
        cached = conn.execute(
            "SELECT job_id, status FROM trackid_jobs WHERE youtube_url = ?",
            (normalized_url,),
        ).fetchone()

        if cached and not force:
            stats["skipped_cached"] = 1
            return stats

        # 3. Submit job
        try:
            job_id = submit_job(normalized_url, cfg)
        except RuntimeError:
            stats["failed"] = 1
            return stats

        # Upsert into trackid_jobs (INSERT or UPDATE for --force)
        if cached:
            conn.execute(
                "UPDATE trackid_jobs SET job_id=?, status='queued', "
                "tracks_found=NULL, tracks_imported=NULL WHERE youtube_url=?",
                (job_id, normalized_url),
            )
        else:
            conn.execute(
                "INSERT INTO trackid_jobs (youtube_url, job_id, status) VALUES (?, ?, 'queued')",
                (normalized_url, job_id),
            )
        conn.commit()

        # 4. Poll for results
        try:
            job = poll_job(job_id, cfg)
        except PollTimeoutError:
            # Job stays 'queued' in cache
            conn.commit()
            stats["failed"] = 1
            return stats
        except RuntimeError:
            conn.execute(
                "UPDATE trackid_jobs SET status='failed' WHERE youtube_url=?",
                (normalized_url,),
            )
            conn.commit()
            stats["failed"] = 1
            return stats

        # 5. Filter and insert tracks
        all_tracks = job.get("tracks", [])
        threshold = cfg.trackid.confidence_threshold

        for track in all_tracks:
            if track.get("isUnknown"):
                stats["skipped_unknown"] += 1
                continue
            if track.get("confidence", 0) < threshold:
                stats["skipped_low_confidence"] += 1
                continue

            stats["identified"] += 1

            artist = track.get("artist") or ""
            title = track.get("title") or ""
            duration_sec = track.get("duration")
            duration_ms = int(duration_sec * 1000) if duration_sec is not None else None

            record = {
                "acquisition_status": "candidate",
                "source": "trackid",
                "artist": artist or None,
                "artists": artist or None,
                "title": title or None,
                "duration_ms": duration_ms,
                "search_string": build_search_string(artist, title) if (artist or title) else None,
            }

            columns = ", ".join(record.keys())
            placeholders = ", ".join("?" for _ in record)
            try:
                conn.execute(
                    f"INSERT INTO tracks ({columns}) VALUES ({placeholders})",
                    list(record.values()),
                )
                stats["imported"] += 1
            except sqlite3.IntegrityError:
                pass  # shouldn't happen (no UNIQUE constraint), but be safe

        conn.commit()

        # 6. Update cache
        conn.execute(
            "UPDATE trackid_jobs SET status='completed', tracks_found=?, tracks_imported=? "
            "WHERE youtube_url=?",
            (len(all_tracks), stats["imported"], normalized_url),
        )
        conn.commit()

    return stats
```

- [ ] **Step 5.4: Run all trackid tests**

```bash
poetry run pytest tests/test_trackid_importer.py -v
```

Expected: all PASS.

- [ ] **Step 5.5: Run full test suite to check for regressions**

```bash
poetry run pytest -x -q
```

Expected: all PASS (no regressions).

- [ ] **Step 5.6: Commit**

```bash
git add djtoolkit/importers/trackid.py tests/test_trackid_importer.py
git commit -m "feat: implement import_trackid() orchestration with cache and filtering"
```

---

## Chunk 3: CLI + Makefile

### Task 6: CLI subcommand

**Files:**
- Modify: `djtoolkit/__main__.py`
- Test: `tests/test_trackid_importer.py`

- [ ] **Step 6.1: Write a smoke test for the CLI command**

Add to `tests/test_trackid_importer.py`:

```python
from typer.testing import CliRunner
from djtoolkit.__main__ import app

runner = CliRunner()


def test_cli_import_trackid_invalid_url():
    """CLI exits non-zero and prints error on invalid URL."""
    result = runner.invoke(app, ["import", "trackid", "--url", "https://vimeo.com/123"])
    assert result.exit_code != 0
    assert "YouTube" in result.output or "valid" in result.output.lower()


def test_cli_import_trackid_missing_url():
    """CLI exits non-zero when --url is not provided."""
    result = runner.invoke(app, ["import", "trackid"])
    assert result.exit_code != 0
```

- [ ] **Step 6.2: Run tests to verify they fail**

```bash
poetry run pytest tests/test_trackid_importer.py -k "cli" -v
```

Expected: FAIL — subcommand does not exist yet.

- [ ] **Step 6.3: Add import trackid subcommand to __main__.py**

In `djtoolkit/__main__.py`, in the `# ─── import commands ───` section, add after the `import_folder` command:

```python
@import_app.command("trackid")
def import_trackid_cmd(
    url: Annotated[str, typer.Option("--url", help="YouTube URL of DJ mix to identify")],
    force: Annotated[bool, typer.Option("--force", help="Re-submit even if URL is cached")] = False,
    config: ConfigOpt = "djtoolkit.toml",
):
    """Identify tracks in a YouTube DJ mix via TrackID.dev (Flow 3)."""
    from djtoolkit.importers.trackid import import_trackid, validate_url

    try:
        normalized = validate_url(url)
    except ValueError as e:
        console.print(f"[red]Invalid URL:[/red] {e}")
        raise typer.Exit(1)

    cfg = _cfg(config)
    console.print(f"Submitting to TrackID.dev: [bold]{normalized}[/bold]")

    try:
        stats = import_trackid(normalized, cfg, force=force)
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(1)

    if stats.get("skipped_cached"):
        console.print(
            "[yellow]URL already processed.[/yellow] Use [bold]--force[/bold] to re-submit."
        )
        return

    if stats["failed"]:
        console.print("[red]✗[/red] TrackID.dev job failed or timed out.")
        raise typer.Exit(1)

    console.print(
        f"[green]✓[/green] Imported [bold]{stats['imported']}[/bold] tracks  "
        f"[yellow]{stats['skipped_low_confidence']}[/yellow] low-confidence  "
        f"{stats['skipped_unknown']} unknown"
    )
    if stats["identified"] == 0:
        console.print("[yellow]Warning: TrackID found 0 identifiable tracks in this mix.[/yellow]")
```

- [ ] **Step 6.4: Run CLI tests**

```bash
poetry run pytest tests/test_trackid_importer.py -k "cli" -v
```

Expected: PASS.

- [ ] **Step 6.5: Run full test suite**

```bash
poetry run pytest -x -q
```

Expected: all PASS.

- [ ] **Step 6.6: Commit**

```bash
git add djtoolkit/__main__.py tests/test_trackid_importer.py
git commit -m "feat: add djtoolkit import trackid CLI subcommand"
```

---

### Task 7: Makefile target

**Files:**
- Modify: `Makefile`

- [ ] **Step 7.1: Add import-trackid target and URL variable to Makefile**

In the `.PHONY` line at the top, add `import-trackid`.

Add `URL` variable in the existing variable block, after the `DIR ?=` line (around line 34):

```makefile
URL     ?=
```

Add the target in the `# ── Flow 3 ─` section (create the section between Flow 2 and Utilities):

```makefile
# ── Flow 3: YouTube mix → Identified tracks ───────────────────────────────────

import-trackid:
	@test -n "$(URL)" || (echo "Usage: make import-trackid URL=https://youtu.be/..." && exit 1)
	$(DJ) import trackid --url "$(URL)" --config $(CONFIG)
```

Add to the help text:

```makefile
@echo "  import-trackid  URL=<youtube_url>  identify tracks in a YouTube mix"
```

- [ ] **Step 7.2: Verify the Makefile target is syntactically valid**

```bash
make --dry-run import-trackid URL=https://youtu.be/dQw4w9WgXcQ 2>&1 | head -5
```

Expected: shows the command it would run, no syntax errors.

- [ ] **Step 7.3: Commit**

```bash
git add Makefile
git commit -m "feat: add import-trackid Makefile target for Flow 3"
```

---

## Final Verification

- [ ] **Run complete test suite**

```bash
poetry run pytest -v
```

Expected: all PASS.

- [ ] **Smoke-test the full CLI help**

```bash
poetry run djtoolkit import --help
```

Expected: shows `trackid` subcommand listed.

```bash
poetry run djtoolkit import trackid --help
```

Expected: shows `--url` and `--force` options.

- [ ] **Verify Makefile help**

```bash
make help
```

Expected: `import-trackid` appears in the output.
