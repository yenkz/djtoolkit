# Contributing to djtoolkit

Thanks for your interest in contributing! djtoolkit is a personal DJ library management tool, and contributions — bug reports, ideas, fixes, and new features — are welcome.

---

## Getting Started

### 1. Fork & clone

```bash
git clone https://github.com/youruser/djtoolkit.git
cd djtoolkit
```

### 2. Set up your dev environment

```bash
# Install dependencies (requires Python 3.11+ and Poetry)
make install

# Copy config templates
make init

# Initialize the database
make setup
```

### 3. Run the tests

```bash
poetry run pytest
```

All tests should pass before you submit a PR.

---

## How to Contribute

### Reporting a bug

Open an issue and include:
- What you were trying to do
- The exact command or action
- The error message or unexpected output
- Your OS, Python version (`python --version`), and Poetry version (`poetry --version`)

### Suggesting a feature

Open an issue describing the use case. What problem does the feature solve? How would it fit into the existing flows?

### Submitting a fix or feature

1. **Open an issue first** for anything non-trivial — this prevents duplicate work
2. Fork the repo and create a branch:
   ```bash
   git checkout -b fix/short-description    # for bug fixes
   git checkout -b feat/short-description   # for new features
   ```
3. Make your changes (see guidelines below)
4. Run tests and the linter:
   ```bash
   poetry run pytest
   poetry run python -m py_compile djtoolkit/**/*.py
   ```
5. Commit with a clear message:
   ```bash
   git commit -m "fix: writer skips tracks with missing local_path"
   git commit -m "feat: move-to-library organizes by genre subfolder"
   ```
6. Push and open a pull request

---

## Pull Request Guidelines

When opening a PR, please include:

**Title** — short and descriptive (≤ 72 chars), prefixed with `fix:`, `feat:`, `docs:`, `refactor:`, or `chore:`.

**Description** — use this template:

```markdown
## What does this PR do?
Brief description of the change.

## Why?
What problem does it solve, or what improvement does it make?

## How to test
Steps to verify the change works correctly.

## Checklist
- [ ] Tests pass (`poetry run pytest`)
- [ ] No new linter errors
- [ ] `make migrate-db` updated if schema changed
- [ ] CLAUDE.md updated if architecture or commands changed
```

---

## Code Guidelines

- **Python 3.11+** — use stdlib where possible (`tomllib`, `pathlib`, `sqlite3`)
- **`pathlib.Path` everywhere** — never hardcode `/` or `\\` separators
- **No global imports of optional deps** — lazy-import anything that might not be installed (see `aioslsk` pattern in `downloader/aioslsk_client.py`)
- **SQLite is the source of truth** — all state lives in the DB; don't track status in memory across runs
- **Idempotency** — every pipeline step should be safe to re-run; always filter by the appropriate flag (`fingerprinted = 0`, `metadata_written = 0`, etc.)
- **Return stats dicts** — every `run()` function returns `{"key": count, ...}` for CLI/UI reporting
- **Keep it simple** — this is a personal tool; avoid premature abstraction

---

## Project Structure

See [CLAUDE.md](CLAUDE.md) for the full module map, database schema, and implementation notes.

---

## Questions?

Open an issue — happy to discuss anything.
