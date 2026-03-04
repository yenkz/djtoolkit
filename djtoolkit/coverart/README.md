# djtoolkit/coverart

Fetches album cover art from online sources and embeds it directly into audio files.

---

## Files

| File | Description |
|---|---|
| `art.py` | Art fetcher + mutagen embedder |

---

## How it works

For each eligible track (`acquisition_status = 'available'`, `local_path` exists, `cover_art_written = 0`):

1. **Skip check** — if the file already contains embedded art (detected via mutagen), mark `cover_art_written = 1` and skip (unless `force = true`)
2. **Fetch** — try each configured source in order until a valid image is returned
3. **Validate** — reject images narrower than `minwidth`; resize images wider than `maxwidth` (requires Pillow)
4. **Embed** — write image bytes into the file:
   - FLAC: native PICTURE block (`type=3` Front Cover)
   - MP3: ID3 `APIC` frame (`type=3` Front Cover)
   - M4A/AAC: `covr` MP4 atom
5. **Update DB** — sets `cover_art_written = 1`

---

## Art sources

| Source | API | Notes |
|---|---|---|
| `coverart` | Cover Art Archive (MusicBrainz) | Free, no auth. Searches by artist + album name, returns up to 1200px |
| `itunes` | iTunes Search API | Free, no auth. Returns up to 3000×3000px |
| `amazon` | — | Not implemented (no reliable public API) |
| `albumart` | — | Not implemented (no public API) |

Sources are tried in the order listed in `sources`. The first successful result is used.

---

## Configuration

```toml
[cover_art]
force      = false            # re-embed even if the file already has art
skip_embed = false            # dry-run: fetch only, don't write to file
sources    = "coverart itunes"  # space-separated, tried in order
minwidth   = 800              # reject images narrower than this (px)
maxwidth   = 2000             # resize images wider than this (px, requires Pillow)
quality    = 90               # JPEG quality when re-encoding after resize
```

**Idempotency** — `cover_art_written = 1` tracks are skipped on subsequent runs.
Re-run with `force = true` to overwrite existing artwork.

---

## Public API

```python
from djtoolkit.coverart.art import run

stats = run(cfg)
# stats = {"embedded": 42, "failed": 1, "skipped": 5, "no_art_found": 3}
```

| Key | Meaning |
|---|---|
| `embedded` | Art successfully fetched and written to file |
| `failed` | Fetch succeeded but embed raised an error |
| `skipped` | File missing, unsupported format, or already has art |
| `no_art_found` | All sources returned nothing, or image was below `minwidth` |

---

## CLI

```bash
# Embed cover art for all tracks that need it
make fetch-cover-art

# Force re-embed even if art already present (set force=true in config first)
djtoolkit coverart fetch
```

---

## Optional dependency: Pillow

Pillow is used to resize images that exceed `maxwidth`. Without it, oversized images are
embedded as-is (still functional — just potentially larger than configured).

```bash
poetry add Pillow   # or: pip install Pillow
```

---

## Supported formats

| Format | Extension | Embed method |
|---|---|---|
| MP3 | `.mp3` | ID3 `APIC` frame |
| FLAC | `.flac` | PICTURE metadata block |
| AAC / M4A | `.m4a`, `.aac` | MP4 `covr` atom |

`.ogg` and `.wav` are not supported for cover art embedding.
