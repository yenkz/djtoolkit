FROM python:3.11-slim AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        libchromaprint-tools \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY djtoolkit/ ./djtoolkit/
RUN uv sync --frozen --no-dev

FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libchromaprint-tools \
        ffmpeg \
        curl \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# Install deno — yt-dlp's default JS runtime for YouTube signature solving
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
ENV DENO_DIR=/tmp/deno

RUN useradd --create-home --shell /bin/bash app
WORKDIR /app

COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/djtoolkit /app/djtoolkit

USER app
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000

CMD ["uvicorn", "djtoolkit.service.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--timeout-graceful-shutdown", "900"]
