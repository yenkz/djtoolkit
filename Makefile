.PHONY: init install setup import-csv download fingerprint apply-metadata move-to-library \
        import-folder enrich migrate-db check-db wipe-db normalize playlist ui dev \
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
	poetry install

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
	$(DJ) move-to-library --config $(CONFIG)

# ── Flow 2: Folder → DB ───────────────────────────────────────────────────────

import-folder:
	@test -n "$(DIR)" || (echo "Usage: make import-folder DIR=path/to/folder" && exit 1)
	$(DJ) import folder $(DIR) --config $(CONFIG)

ARGS    ?=

enrich:
	$(DJ) enrich --config $(CONFIG) $(ARGS)

# ── Utilities ─────────────────────────────────────────────────────────────────

migrate-db:
	$(DJ) db migrate --config $(CONFIG)

check-db:
	$(DJ) db check --config $(CONFIG)

wipe-db:
	@echo "⚠️  This will delete all data in the database. Press Ctrl-C to cancel."
	@read -p "Type 'wipe' to confirm: " confirm && [ "$$confirm" = "wipe" ]
	$(DJ) db wipe --config $(CONFIG)

## not implemented yet, but will run various normalization steps on the database (e.g. genre/style cleanup, filename cleanup, etc.)

normalize:
	$(DJ) normalize --config $(CONFIG)

playlist:
	$(DJ) playlist --config $(CONFIG)

dedup:
	$(DJ) dedup --config $(CONFIG)

# ── Docker / slskd ───────────────────────────────────────────────────────────

install-docker:
	@if [ "$(DETECTED_OS)" = "macos" ]; then \
		if command -v docker >/dev/null 2>&1; then \
			echo "Docker already installed."; \
		else \
			brew install --cask docker; \
			echo "Docker Desktop installed. Start it from Applications before running 'make slskd-up'."; \
		fi; \
	elif [ "$(DETECTED_OS)" = "linux" ]; then \
		echo "Install Docker Engine via your distro packages (e.g. apt install docker.io docker-compose-plugin)."; \
	else \
		echo "Install Docker Desktop from https://www.docker.com/products/docker-desktop/"; \
	fi

slskd-up:
	docker compose up -d
	@echo "slskd running at http://localhost:5030"

slskd-down:
	docker compose down

slskd-logs:
	docker compose logs -f slskd

slskd-status:
	docker compose ps

# ── Dev / UI ──────────────────────────────────────────────────────────────────

ui:
	$(PYTHON) -m uvicorn djtoolkit.api.app:app --reload --port 8000

dev: ui

# ── Tests ─────────────────────────────────────────────────────────────────────

test:
	poetry run pytest

lint:
	poetry run python -m py_compile djtoolkit/**/*.py
