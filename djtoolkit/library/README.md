# djtoolkit/library

Moves fully processed tracks into the final library directory.

---

## Files

| File | Description |
|---|---|
| `mover.py` | Move tagged files from downloads to `library_dir`, set `in_library=1` |

---

## How it works

This is the **final step** in both flows. Two modes control which tracks are selected:

| Mode | SQL filter | Typical use |
| --- | --- | --- |
| `metadata_applied` (default) | `available AND metadata_written=1 AND in_library=0` | Flow 1 — after `apply-metadata` |
| `imported` | `available AND in_library=0` | Flow 2 — folder imports that skip the writer step |

For each matched track:

1. Resolves the current `local_path` (the renamed file in the download directory)
2. Moves it to `library_dir` using `shutil.move` (atomic on same filesystem, copy+delete across filesystems)
3. Handles filename collisions by appending `_{track_id}` to the stem
4. Updates `local_path` to the new library path
5. Sets `in_library=1`

---

## Public API

```python
from djtoolkit.library.mover import run

stats = run(cfg)                        # default: mode='metadata_applied'
stats = run(cfg, mode="imported")       # skip metadata_written requirement
# stats = {"moved": 42, "failed": 1, "skipped": 2}
```

`skipped` = file no longer exists at `local_path` (moved or deleted externally).
`failed` = OS-level error during `shutil.move` (permissions, disk full, etc.).

---

## Configuration

```toml
[paths]
library_dir = "~/Music/DJ/library"   # destination folder
```

The directory is created automatically if it doesn't exist.

---

## CLI

```bash
make move-to-library                  # default: metadata_applied mode
make move-to-library MODE=imported    # for folder-imported tracks
```

Or via the CLI directly:

```bash
poetry run djtoolkit move-to-library --mode imported
```

---

## After this step

Once `in_library=1`, the file is at its permanent location and `local_path` reflects the library path. At this point the track is fully processed:

- Tagged with correct metadata
- Deduplicated by fingerprint
- In the library folder, ready for any DJ software
