# djtoolkit/utils

Shared utilities used across modules.

---

## Files

| File | Description |
|---|---|
| `search_string.py` | Build a normalized slskd search query from artist + title |

---

## search_string.py

Builds the `search_string` field used for Soulseek queries. The goal is a clean, searchable string that matches how files are commonly named on Soulseek.

**Entry point:**
```python
from djtoolkit.utils.search_string import build

query = build("Aphex Twin", "Windowlicker")
# → "aphex twin windowlicker"

query = build("The Prodigy feat. Maxim", "Poison (Radio Edit)")
# → "the prodigy poison (radio edit)"
```

**Rules applied:**
1. Use only the first artist (before `;`)
2. Strip `feat.`, `ft.`, `vs.` and the content that follows on the artist field
3. Keep remix/version info in the title (e.g. `(Radio Edit)`, `(Extended Mix)`) — helps match the correct version on Soulseek
4. Remove special characters except spaces and common punctuation
5. Collapse multiple spaces
6. Lowercase everything
7. Format: `"{artist} {title}"`

The resulting string is stored in `tracks.search_string` at import time and used directly as the slskd search query.
