.PHONY: init install import-csv download fingerprint apply-metadata move-to-library \
        import-folder enrich fetch-cover-art normalize playlist dev \
        test lint import-trackid

.DEFAULT_GOAL := help

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  init            copy example config files (.env, djtoolkit.toml)"
	@echo "  install         poetry install"
	@echo ""
	@echo "  import-csv      CSV=path  import Exportify CSV"
	@echo "  download        download candidate tracks via Soulseek"
	@echo "  fingerprint     run Chromaprint, mark duplicates"
	@echo "  apply-metadata  write tags + normalize filenames"
	@echo "  move-to-library move tagged files into library_dir"
	@echo ""
	@echo "  import-folder   DIR=path  scan existing folder"
	@echo "  import-trackid  URL=<youtube_url>  identify tracks in a YouTube mix"
	@echo "  enrich          ARGS='...' enrich DB only"
	@echo "  fetch-cover-art embed cover art"
	@echo ""
	@echo "  dev             start Next.js dev server"
	@echo "  test            run pytest"

PYTHON  := poetry run python
DJ      := $(PYTHON) -m djtoolkit
CONFIG  ?= djtoolkit.toml
CSV     ?=
DIR     ?=
URL     ?=

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
	@echo "Next: add your Soulseek credentials to djtoolkit.toml [soulseek] and .env"

install:
	poetry install --lock --no-interaction

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

# ── Flow 3: YouTube mix → Identified tracks ───────────────────────────────────

import-trackid:
	@test -n "$(URL)" || (echo "Usage: make import-trackid URL=https://youtu.be/..." && exit 1)
	$(DJ) import trackid --url "$(URL)" --config $(CONFIG)

# ── Utilities ─────────────────────────────────────────────────────────────────

normalize:
	$(DJ) normalize --config $(CONFIG)

playlist:
	$(DJ) playlist --config $(CONFIG)

dedup:
	$(DJ) dedup --config $(CONFIG)

# ── Dev ───────────────────────────────────────────────────────────────────────

dev:
	cd web && npm run dev

# ── Tests ─────────────────────────────────────────────────────────────────────

test:
	poetry run pytest

lint:
	poetry run python -m py_compile djtoolkit/**/*.py
