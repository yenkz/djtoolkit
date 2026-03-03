# djtoolkit/importers

Track importers — bring tracks into the DB as the first step in each flow.

---

## Files

| File | Flow | Description |
|---|---|---|
| `exportify.py` | Flow 1 | Parse an Exportify CSV and insert tracks with `acquisition_status='candidate'` |
| `folder.py` | Flow 2 | Scan a directory of audio files and insert tracks with `acquisition_status='available'` |

---

## exportify.py

Parses the Exportify CSV format (24 columns including Spotify audio features) and inserts one row per track into `tracks`.

**Entry point:**
```python
from djtoolkit.importers.exportify import import_csv

result = import_csv(csv_path, db_path)
# result = {"inserted": 120, "skipped_duplicate": 5, "total": 125}
```

- Deduplicates by `spotify_uri` — tracks already in the DB are silently skipped
- Derives `artist` (first artist before `;`) and `year` (first 4 chars of `release_date`) automatically
- Builds a `search_string` for each track via `utils/search_string.py`

**CLI:** `make import-csv CSV=path/to.csv`

---

## folder.py

Scans a directory recursively for audio files (`.mp3`, `.flac`, `.m4a`, `.aac`, `.ogg`, `.wav`) and inserts them as `available` tracks.

**Entry point:**
```python
from djtoolkit.importers.folder import import_folder

result = import_folder(folder_path, cfg)
# result = {"inserted": 80, "skipped_duplicate": 3}
```

- Reads existing tags (title, artist, album) from files using mutagen
- If fingerprinting is enabled in config, runs `fpcalc` on each file at import time
- Skips files whose Chromaprint fingerprint already exists in the DB (true duplicate detection)
- Uses `pathlib.Path` for all file operations

**CLI:** `make import-folder DIR=path/to/folder`

---

## Exportify CSV format

Expected column headers (exact, space-sensitive):

```
Track URI, Track Name, Album Name, Artist Name(s), Release Date, Duration (ms),
Popularity, Explicit, Added By, Added At, Genres, Record Label,
Danceability, Energy, Key, Loudness, Mode, Speechiness, Acousticness,
Instrumentalness, Liveness, Valence, Tempo, Time Signature
```

Export from [exportify.net](https://exportify.net) — these headers match exactly.
