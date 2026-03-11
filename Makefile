.PHONY: init install setup import-csv download fingerprint apply-metadata move-to-library \
        import-folder enrich fetch-cover-art migrate-db check-db wipe-db reconcile normalize playlist ui dev \
        test lint \
        install-docker slskd-up slskd-down slskd-logs slskd-status

PYTHON  := poetry run python
DJ      := $(PYTHON) -m djtoolkit
CONFIG  ?= djtoolkit.toml
CSV     ?=
DIR     ?=

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
  DETECTED_OS := macos
else ifeq ($(UNAME_S),Linux)
  DETECTED_OS := linux
else
  DETECTED_OS := windows
endif

# ── Setup ────────────────────────────────────────────────────────────────────

init:
	@test -f djtoolkit.toml || (cp djtoolkit.toml.example djtoolkit.toml && echo "Created djtoolkit.toml from example")
	@test -f .env           || (cp .env.example .env && echo "Created .env from example")
	@echo "Next: run 'make slskd-up' to start the slskd container (requires Docker)"

install:
	poetry install --lock --no-interaction

setup:
	$(DJ) db setup --config $(CONFIG)

# ── Flow 1: Exportify CSV → Downloaded + Tagged ───────────────────────────────

import-csv:
	@test -n "$(CSV)" || (echo "Usage: make import-csv CSV=path/to/export.csv" && exit 1)
	$(DJ) import csv $(CSV) --config $(CONFIG)

download:
	$(DJ) download --config $(CONFIG)

fingerprint:
	$(DJ) fingerprint --config $(CONFIG)

apply-metadata:
	$(DJ) metadata apply --config $(CONFIG)

move-to-library:
	$(DJ) move-to-library --mode $(MODE) --config $(CONFIG)

# ── Flow 2: Folder → DB ───────────────────────────────────────────────────────

import-folder:
	@test -n "$(DIR)" || (echo "Usage: make import-folder DIR=path/to/folder" && exit 1)
	$(DJ) import folder $(DIR) --config $(CONFIG)

ARGS    ?=
MODE    ?= metadata_applied

enrich:
	$(DJ) enrich --config $(CONFIG) $(ARGS)

fetch-cover-art:
	$(DJ) coverart fetch --config $(CONFIG)

# ── Utilities ─────────────────────────────────────────────────────────────────

migrate-db:
	$(DJ) db migrate --config $(CONFIG)

check-db:
	$(DJ) db check --config $(CONFIG)

wipe-db:
	@echo "⚠️  This will delete all data in the database. Press Ctrl-C to cancel."
	@read -p "Type 'wipe' to confirm: " confirm && [ "$$confirm" = "wipe" ]
	$(DJ) db wipe --config $(CONFIG)

reconcile:
	$(DJ) db reconcile --config $(CONFIG)

## not implemented yet, but will run various normalization steps on the database (e.g. genre/style cleanup, filename cleanup, etc.)

normalize:
	$(DJ) normalize --config $(CONFIG)

playlist:
	$(DJ) playlist --config $(CONFIG)

dedup:
	$(DJ) dedup --config $(CONFIG)

# ── Dev / UI ──────────────────────────────────────────────────────────────────

ui:
	$(PYTHON) -m uvicorn djtoolkit.api.app:app --reload --port 8000

dev: ui

# ── Tests ─────────────────────────────────────────────────────────────────────

test:
	poetry run pytest

lint:
	poetry run python -m py_compile djtoolkit/**/*.py
