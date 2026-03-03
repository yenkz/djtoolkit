# djtoolkit/db

SQLite database layer — connection helper, schema setup, and migrations.

---

## Files

| File | Purpose |
|---|---|
| `schema.sql` | `CREATE TABLE` statements for all tables (`tracks`, `fingerprints`, `track_embeddings`) |
| `database.py` | Connection helper + `setup`, `migrate`, `check`, `wipe` functions |

---

## Public API

```python
from djtoolkit.db.database import connect, setup, migrate, check, wipe

# Get a connection (row_factory=sqlite3.Row, WAL mode, FK enforcement on)
conn = connect(cfg.db_path)

# Initialize schema (safe on existing DB — uses CREATE TABLE IF NOT EXISTS)
setup(cfg.db_path)

# Add missing columns to an existing DB (idempotent)
migrate(cfg.db_path)

# Run PRAGMA integrity_check — returns [] if OK, list of issues otherwise
issues = check(cfg.db_path)

# Drop all tables and recreate from schema (destructive)
wipe(cfg.db_path)
```

---

## Conventions

- All connections use `row_factory = sqlite3.Row` — rows behave like dicts
- WAL journal mode is always enabled for concurrent read/write access
- `PRAGMA foreign_keys = ON` is set on every connection
- Use `connect()` as a context manager: `with connect(path) as conn:`
- Always call `conn.commit()` explicitly after writes

---

## Schema migrations

When adding a new column:
1. Add it to `schema.sql`
2. Add it to the `new_cols` list in `database.py:migrate()`
3. Document it in [docs/database.md](../../docs/database.md)
4. Run `make migrate-db` to apply on existing DBs

See [docs/database.md](../../docs/database.md) for the full schema reference.
