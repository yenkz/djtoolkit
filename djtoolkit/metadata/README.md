# djtoolkit/metadata

Writes DB metadata to audio files and normalizes filenames.

---

## Files

| File | Description |
|---|---|
| `writer.py` | mutagen tag writer + `Artist - Title.ext` filename normalizer |

---

## How it works

For each `available AND metadata_written=0 AND source='exportify'` track:

1. **Write tags** — uses mutagen to write `title`, `artist`, `album`, `year`, `genre` to the file
   - MP3: `EasyID3`
   - FLAC: native Vorbis comments
   - M4A/AAC: `MP4` atom tags
   - Other: generic mutagen fallback
2. **Normalize filename** — renames the file to `Artist - Title.ext` using safe characters (strips `< > : " / \ | ? *` and control characters)
3. **Collision handling** — if the target filename already exists, appends `_{track_id}` to the stem
4. Updates `local_path` and sets `metadata_written=1`

---

## Public API

```python
from djtoolkit.metadata.writer import run

stats = run(cfg)
# stats = {"applied": 42, "failed": 1, "skipped": 3}
```

`skipped` means the `local_path` file didn't exist on disk (e.g. moved externally).

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
make apply-metadata
```

Only processes `source='exportify'` tracks. Folder-imported tracks (`source='folder'`) already have their original filenames and tags preserved from import.
