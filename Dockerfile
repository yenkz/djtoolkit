FROM python:3.11-slim AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        libchromaprint-tools \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV POETRY_VERSION=2.3.2 \
    POETRY_HOME=/opt/poetry \
    POETRY_VIRTUALENVS_IN_PROJECT=true \
    POETRY_NO_INTERACTION=1

RUN pip install --no-cache-dir poetry==$POETRY_VERSION

WORKDIR /app

COPY pyproject.toml poetry.lock ./
RUN poetry install --only main --no-root

COPY djtoolkit/ ./djtoolkit/
RUN poetry install --only main

FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libchromaprint-tools \
        ffmpeg \
        nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash app
WORKDIR /app

COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/djtoolkit /app/djtoolkit

USER app
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000

CMD ["uvicorn", "djtoolkit.service.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
