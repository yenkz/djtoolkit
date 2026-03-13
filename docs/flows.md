# Pipeline Flows

djtoolkit has two primary flows depending on where your music comes from.

---

## Flow 1 — Exportify CSV → Downloaded + Tagged {#flow-1}

Use this when you have a Spotify playlist exported via [Exportify](https://exportify.net) and want to download the tracks via Soulseek.

### Step-by-step

#### 1. Export your Spotify playlist

Go to [exportify.net](https://exportify.net), log in with Spotify, and export the playlist as CSV. The CSV includes full track metadata and Spotify audio features (BPM, danceability, energy, etc.).

#### 2. Import the CSV

```bash
make import-csv CSV=~/Downloads/my_playlist.csv
```

Parses the CSV and inserts tracks into the DB with `acquisition_status = 'candidate'`. Tracks already in the DB (matched by `spotify_uri`) are skipped.

Each track gets a `search_string` built from the primary artist and title, normalized for Soulseek queries (collapses feat./ft., strips special chars).

#### 3. Download via Soulseek

```bash
make download
```

For each `candidate` track:
1. Searches Soulseek with the `search_string`
2. Waits up to `search_timeout_sec` for results
3. Scores each result with fuzzy matching (title + artist) against expected metadata, filtered by `duration_tolerance_ms`
4. Downloads the best match above `min_score`
5. Sets `acquisition_status = 'downloading'`, then `available` on success or `failed` on error

Requires Soulseek credentials configured in `djtoolkit.toml` (`[soulseek]` section).

#### 4. Fingerprint

```bash
make fingerprint
```

Runs `fpcalc` (Chromaprint) on every `available AND fingerprinted=0` track:
- Computes a fingerprint and optionally looks it up in AcoustID
- If the fingerprint matches an existing track, marks the new one as `duplicate`
- Otherwise stores the fingerprint in the `fingerprints` table and sets `fingerprinted=1`

Requires `fpcalc` installed (`brew install chromaprint`).

#### 5. Apply metadata

```bash
make apply-metadata
```

For each `available AND metadata_written=0` track:

- Writes tags (title, artist, album, year, genre, BPM, key) to the audio file using mutagen
- Renames the file to `Artist - Title.ext` format
- Updates `local_path` and sets `metadata_written=1`

#### 6. Move to library

```bash
make move-to-library
```

For each `available AND metadata_written=1 AND in_library=0` track (the `metadata_applied` default mode):
- Moves the file from its download location to `library_dir` (configured in `djtoolkit.toml`)
- Updates `local_path` to the final path
- Sets `in_library=1`

After this step, all tracks are in your library folder, fully tagged and ready for use in any DJ software.

### Full Flow 1 command sequence

```bash
make import-csv CSV=~/Downloads/playlist.csv
make download
make fingerprint
make apply-metadata
make move-to-library
```

---

## Flow 2 — Folder → Enriched + Organized {#flow-2}

Use this when you already have audio files on disk (e.g. purchased tracks, previous downloads) and want to bring them into the djtoolkit library.

### Step-by-step

#### 1. Scan a folder

```bash
make import-folder DIR=~/Downloads/vinyl_rips/
```

Scans the directory recursively for audio files (`.mp3`, `.flac`, `.m4a`, `.aac`, `.ogg`, `.wav`):

- Reads existing tags (title, artist, album)
- Optionally runs `fpcalc` immediately if fingerprinting is enabled
- Inserts each track with `acquisition_status = 'available'`
- Skips files whose fingerprint already exists in the DB

#### 2. Apply metadata from a source

This is where you tell djtoolkit *where* the metadata values should come from. Pick the approach that fits your situation.

##### Option A — Spotify/Exportify (recommended if you have a matching playlist CSV)

Does two things in one command: enriches the DB from the CSV, then writes tags to the matched files.

```bash
djtoolkit metadata apply --source spotify --csv ~/Downloads/playlist.csv
```

- Matches tracks by fuzzy artist + title (or `spotify_uri` if already set)
- Writes title, artist, album, year, genre, BPM, key to the audio file
- Renames to `Artist - Title.ext`
- Records `metadata_source = 'spotify'` in the DB
- **Idempotent** — re-running the same command with the same CSV skips already-tagged files

##### Option B — Audio analysis (BPM, key, loudness via librosa)

```bash
djtoolkit metadata apply --source audio-analysis
```

Analyzes each file with librosa and writes BPM + key tags. Can be layered on top of Option A (last source applied wins for overlapping fields like tempo and key).

##### Option C — Two-step (enrich DB first, write tags separately)

If you prefer to inspect DB values before writing to files:

```bash
make enrich ARGS='--spotify ~/Downloads/playlist.csv'   # DB only
make apply-metadata                                      # write tags (no specific source recorded)
```

#### 3. Move to library

```bash
make move-to-library
```

Moves tagged files (those with `metadata_written=1`) into `library_dir`. If you used Option C above and did not run `apply-metadata`, or if you want to move files that still carry their original tags, use:

```bash
make move-to-library MODE=imported
```

This selects all `available AND in_library=0` tracks regardless of `metadata_written`.

### Full Flow 2 command sequence (recommended)

```bash
make import-folder DIR=~/Downloads/my_music/
djtoolkit metadata apply --source spotify --csv ~/Downloads/playlist.csv
make move-to-library
```

---

## Resetting failed tracks

If some tracks fail to download:

```bash
# From the web UI:  click "Reset Failed" button
# From CLI:
sqlite3 djtoolkit.db "UPDATE tracks SET acquisition_status='candidate' WHERE acquisition_status='failed'"
make download
```

---

## Checking pipeline status

```bash
make check-db          # DB integrity check
poetry run djtoolkit db status   # track counts by acquisition_status + processing flags
```

Or open the web UI at `http://localhost:3000` after `make api` and `cd web && npm run dev`.
