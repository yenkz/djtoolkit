# Configuration Reference

djtoolkit is configured via a single TOML file (`djtoolkit.toml`) plus optional environment variables for secrets. All settings have sensible defaults — you only need to set what differs from the defaults.

---

## Setup

```bash
make init    # copies djtoolkit.toml.example → djtoolkit.toml and .env.example → .env
```

Edit `djtoolkit.toml` and `.env` to match your environment.

---

## Secrets via environment variables

Sensitive values are read from the environment first, falling back to the TOML value. Put them in `.env` (never commit this file):

```bash
# .env
SLSKD_API_KEY=your-slskd-api-key
ACOUSTID_API_KEY=your-acoustid-api-key
```

---

## Full reference

### `[db]`

```toml
[db]
path = "djtoolkit.db"    # path to the SQLite database file
```

### `[paths]`

```toml
[paths]
downloads_dir = "~/Soulseek/downloads/complete"   # where slskd puts completed downloads
inbox_dir     = "~/Music/DJ/inbox"                 # intermediate staging area (optional)
library_dir   = "~/Music/DJ/library"               # final destination after move-to-library
scan_dir      = ""                                  # used by import-folder; leave empty if unused
```

All paths support `~` expansion and are resolved relative to the shell working directory.

### `[slskd]`

```toml
[slskd]
host              = "http://localhost:5030"   # slskd base URL (no trailing slash)
url_base          = "/api/v0"                 # API prefix — do not change unless you customized slskd
api_key           = ""                        # set via SLSKD_API_KEY env var instead
search_timeout_ms = 90000                     # how long to wait for a search to complete (ms)
response_limit    = 100                       # max search responses per query
file_limit        = 10000                     # max files per response
```

### `[matching]`

Controls fuzzy-matching between Soulseek results and expected track metadata.

```toml
[matching]
min_score          = 0.86     # minimum combined title+artist fuzzy score (0–1)
min_score_title    = 0.78     # minimum title-only fuzzy score
duration_tolerance_ms = 2000  # how far off the duration can be (milliseconds)
```

Raise thresholds for stricter matching; lower them if too many tracks fail to download.

### `[fingerprint]`

```toml
[fingerprint]
acoustid_api_key       = ""       # set via ACOUSTID_API_KEY env var; leave empty to skip AcoustID lookup
fpcalc_path            = ""       # absolute path to fpcalc binary; auto-detected if empty
duration_tolerance_sec = 5.0      # max duration difference for duplicate detection
enabled                = true     # set to false to skip fingerprinting entirely
```

Get a free AcoustID API key at [acoustid.org](https://acoustid.org/login).

### `[loudnorm]`

EBU R128 loudness normalization targets (used by `make normalize` — not yet implemented).

```toml
[loudnorm]
target_lufs = "-9"     # integrated loudness (LUFS)
target_tp   = "-1.0"   # true peak (dBTP)
target_lra  = "9"      # loudness range (LU)
```

### `[cover_art]`

```toml
[cover_art]
force      = false    # re-embed cover art even if already present
skip_embed = false    # skip cover art embedding entirely
```

### `[audio_analysis]`

Controls librosa analysis (always available) and optional essentia-tensorflow models.

```toml
[audio_analysis]
models_dir           = "~/.djtoolkit/models"   # directory for ML model files

# Optional essentia-tensorflow models (Linux/macOS x86_64, Python ≤3.11 only)
musicnn_model        = ""   # path to msd-musicnn-1.pb
discogs_genre_model  = ""   # path to genre_discogs400-discogs-musicnn-1.pb
discogs_genre_labels = ""   # path to genre_discogs400-discogs-musicnn-1-labels.json
instrumental_model   = ""   # path to voice_instrumental-audioset-musicnn-1.pb

genre_top_n       = 3     # number of top genres to store
genre_threshold   = 0.1   # minimum confidence to include a genre
```

Leave model paths empty to use librosa only (cross-platform, no GPU required).

---

## Minimal example

A minimal `djtoolkit.toml` for a typical macOS setup:

```toml
[db]
path = "djtoolkit.db"

[paths]
downloads_dir = "~/Soulseek/downloads/complete"
library_dir   = "~/Music/DJ/library"

[slskd]
host    = "http://localhost:5030"
api_key = ""   # set in .env as SLSKD_API_KEY

[fingerprint]
acoustid_api_key = ""   # set in .env as ACOUSTID_API_KEY
```
