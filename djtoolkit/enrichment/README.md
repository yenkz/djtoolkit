# djtoolkit/enrichment

Enriches track metadata from external sources — Exportify CSV matching and audio analysis.

---

## Files

| File | Description |
|---|---|
| `spotify.py` | Match `available` tracks against an Exportify CSV to fill NULL metadata |
| `audio_analysis.py` | Analyze audio files for BPM, key, loudness (librosa) and optionally genre/vocal classification (essentia-tensorflow) |

---

## spotify.py

Matches tracks already in the DB against an Exportify CSV, filling any NULL metadata columns (genres, BPM, danceability, etc.) without overwriting existing values.

Primarily useful for Flow 2 (folder imports), where files have no Spotify metadata.

**Entry point:**
```python
from djtoolkit.enrichment.spotify import run

stats = run(csv_path, cfg)
# stats = {"matched": 75, "unmatched": 12}
```

Matching strategy: fuzzy title+artist comparison, filtered by duration tolerance (same thresholds as the downloader).

**CLI:** `make enrich ARGS='--spotify ~/Downloads/playlist.csv'`

---

## audio_analysis.py

Analyzes audio files to fill `tempo`, `key`, `loudness`, `danceability`, and optionally genre/instrumental classification.

### Primary analysis (always available — cross-platform)

Uses `librosa` and `pyloudnorm`:

| Feature | Method |
|---|---|
| BPM | `librosa.beat.beat_track` |
| Key | Krumhansl-Schmuckler algorithm on `chroma_cqt` |
| Loudness | EBU R128 integrated LUFS via `pyloudnorm` |
| Danceability | Derived from beat regularity metrics |

### Optional analysis (essentia-tensorflow models)

Requires `essentia-tensorflow` (Linux/macOS x86_64, Python ≤3.11). Gracefully skipped if not installed.

| Feature | Model |
|---|---|
| Genre | `genre_discogs400-discogs-musicnn-1` (400 Discogs genre labels) |
| Vocal/Instrumental | `voice_instrumental-audioset-musicnn-1` |
| Embeddings | Stored in `track_embeddings` table for downstream use |

Models are downloaded separately — see [docs/configuration.md](../../docs/configuration.md#audio_analysis) for setup.

**Entry point:**
```python
from djtoolkit.enrichment.audio_analysis import run

stats = run(cfg)
# stats = {"analyzed": 90, "failed": 2, "skipped": 5}
```

**CLI:**
```bash
make enrich ARGS='--audio-analysis'
make enrich ARGS='--spotify playlist.csv --audio-analysis'   # both at once
```
