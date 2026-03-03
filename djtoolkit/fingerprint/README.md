# djtoolkit/fingerprint

Audio fingerprinting via Chromaprint (`fpcalc`) with optional AcoustID lookup for duplicate detection.

---

## Files

| File | Description |
|---|---|
| `chromaprint.py` | fpcalc wrapper, AcoustID lookup, duplicate detection, batch `run()` |

---

## How it works

For each `available AND fingerprinted=0` track:

1. Runs `fpcalc -json <file>` to get a Chromaprint fingerprint and duration
2. Optionally queries the [AcoustID](https://acoustid.org) API for a canonical recording ID
3. Checks the `fingerprints` table for an identical fingerprint
   - **Match found** → marks track as `duplicate` (keeps the original)
   - **No match** → inserts into `fingerprints`, sets `fingerprinted=1`

---

## Public API

```python
from djtoolkit.fingerprint.chromaprint import calc, lookup_acoustid, run

# Compute fingerprint for a single file
fp_data = calc("/path/to/track.mp3", cfg)
# fp_data = {"fingerprint": "AQADt...", "duration": 237.4} or None

# AcoustID lookup (requires API key in config)
recording_id = lookup_acoustid(fp_data["fingerprint"], fp_data["duration"], api_key)

# Batch run — processes all unfingerprinted available tracks
stats = run(cfg)
# stats = {"fingerprinted": 38, "duplicates": 2, "skipped": 1}
```

---

## Configuration

```toml
[fingerprint]
enabled                = true
fpcalc_path            = ""       # auto-detected; set if fpcalc is not on PATH
acoustid_api_key       = ""       # set via ACOUSTID_API_KEY env var
duration_tolerance_sec = 5.0
```

---

## Prerequisites

- `fpcalc` installed: `brew install chromaprint` (macOS) or `apt install libchromaprint-tools` (Linux)
- AcoustID API key (free at [acoustid.org](https://acoustid.org)) — optional, enriches the `acoustid` column

---

## Duplicate detection note

The current implementation uses exact fingerprint string matching. This is fast and reliable for identical files but will miss near-duplicate files (different bitrate encodes of the same track). A Hamming-distance approach would be more robust for production use.
