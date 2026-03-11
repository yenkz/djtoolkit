# djtoolkit/downloader

Downloads tracks from Soulseek using [aioslsk](https://github.com/JurgenR/aioslsk) — an embedded Python Soulseek client that runs directly within the djtoolkit process.

---

## Files

| File | Description |
|---|---|
| `aioslsk_client.py` | Embedded Soulseek client, search/score/download loop |

---

## How it works

```
candidate tracks → search Soulseek → score results → download best match → mark available
```

1. **Search** — broadcasts a search query to the Soulseek network using `search_string`
2. **Collect results** — waits up to `search_timeout_sec` for peers to respond
3. **Score results** — fuzzy-match each result's title+artist against expected metadata using `thefuzz`; filter by `duration_tolerance_ms` and `min_score`
4. **Download** — enqueues the best match from the peer that returned it
5. **Wait** — polls until `TransferState.COMPLETED` or a terminal failure state

---

## Public API

```python
from djtoolkit.downloader.aioslsk_client import run

# Full download pipeline (search + download + wait)
stats = run(cfg)
# stats = {"attempted": 50, "downloaded": 42, "failed": 8}
```

---

## Configuration

Soulseek settings live under `[soulseek]` in `djtoolkit.toml`:

```toml
[soulseek]
username             = ""       # your Soulseek account username
# password is loaded from SOULSEEK_PASSWORD in .env
search_timeout_sec   = 15.0
download_timeout_sec = 300.0

[matching]
min_score          = 0.86
min_score_title    = 0.78
duration_tolerance_ms = 2000
```

---

## Prerequisites

- Soulseek account credentials configured in `djtoolkit.toml` and `.env`
- `aioslsk` Python package installed (included in `pyproject.toml` dependencies)
