# syntax=docker/dockerfile:1
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        libchromaprint-tools \
        ffmpeg \
        build-essential \
        curl \
    && rm -rf /var/lib/apt/lists/*

ENV POETRY_VERSION=1.8.3 \
    POETRY_HOME=/opt/poetry \
    POETRY_VIRTUALENVS_IN_PROJECT=true \
    POETRY_NO_INTERACTION=1

RUN curl -sSL https://install.python-poetry.org | python3 - \
    && ln -s /opt/poetry/bin/poetry /usr/local/bin/poetry

WORKDIR /app

COPY pyproject.toml poetry.lock ./
RUN poetry install --no-dev --no-root

COPY djtoolkit/ ./djtoolkit/
COPY ui/ ./ui/
RUN poetry install --no-dev

RUN useradd --create-home --shell /bin/bash app \
    && chown -R app:app /app
USER app

EXPOSE 8000

CMD ["poetry", "run", "uvicorn", "djtoolkit.api.app:app", \
     "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
