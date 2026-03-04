# djtoolkit/metadata

Writes DB metadata to audio files and normalizes filenames.

---

## Files

| File | Description |
|---|---|
| `writer.py` | mutagen tag writer + `Artist - Title.ext` filename normalizer |

---

## How it works

For each eligible track (`acquisition_status = 'available'`, `local_path` exists):

1. **Run enrichment inline** (when `--source` is given) — ensures DB reflects the chosen source before writing
2. **Write tags** — uses mutagen to write `title`, `artist`, `album`, `year`, `genre`, `bpm`, `key` to the file
   - MP3: `EasyID3` (TKEY registered for initial key)
   - FLAC: native Vorbis comments
   - M4A/AAC: `MP4` atom tags (`tmpo` for BPM, iTunes freeform atom for key)
   - Other: generic mutagen fallback
3. **Normalize filename** — renames the file to `Artist - Title.ext` using safe characters (strips `< > : " / \ | ? *` and control characters)
4. **Collision handling** — if the target filename already exists, appends `_{track_id}` to the stem
5. **Updates DB** — sets `metadata_written=1`, `metadata_source`, `local_path`

Applies to **all track sources** (`exportify` and `folder`).

---

## Metadata sources

The `--source` flag controls which enrichment pipeline's values are written:

| Source | Enrichment run | Tracks eligible |
|---|---|---|
| `spotify` | `enrichment/spotify.py` (force-overwrite) | `enriched_spotify=1` |
| `audio-analysis` | `enrichment/audio_analysis.py` | `enriched_audio=1` |
| *(none)* | — | `metadata_written=0` (unwritten tracks only) |

**Last-applied-source wins** for overlapping fields (tempo, key, mode, loudness, danceability).
The `metadata_source` DB column records which source was used in the most recent write.

**Idempotency** — when `--source` is given, tracks that already have `metadata_written=1` and
`metadata_source` matching the requested source are skipped. Re-running the same command with the
same source is safe and fast. To overwrite a previously applied source, run with a different
`--source` (e.g. apply `audio-analysis` after `spotify` to update BPM/key tags).

---

## Public API

```python
from djtoolkit.metadata.writer import run

# Write unwritten tracks, no specific source
stats = run(cfg)

# Force Spotify as the metadata source (requires CSV path)
from pathlib import Path
stats = run(cfg, metadata_source="spotify", csv_path=Path("playlist.csv"))

# Force audio analysis as the metadata source
stats = run(cfg, metadata_source="audio-analysis")

# stats = {"applied": 42, "failed": 1, "skipped": 3}
```

`skipped` — either the `local_path` file didn't exist on disk (e.g. moved externally), or the
track was already tagged with the same source (idempotent re-run).

---

## Filename format

```
Artist - Title.ext
```

Examples:
- `Aphex Twin - Windowlicker.mp3`
- `Four Tet - She Moves She.flac`
- `DJ Shadow - Midnight In A Perfect World.m4a`

Special characters in artist or title are replaced with `_`.

---

## CLI

```bash
# Write unwritten tracks using whatever is in the DB
make apply-metadata

# Apply Spotify as the metadata source (re-processes all spotify-enriched tracks)
djtoolkit metadata apply --source spotify --csv path/to/playlist.csv

# Apply audio analysis as the metadata source (re-processes all audio-analyzed tracks)
djtoolkit metadata apply --source audio-analysis
```
