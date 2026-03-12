"""Session-scoped event loop + .env loading for integration tests.

asyncpg pool connections are bound to an event loop. With pytest-asyncio's
default per-function event loop, the pool created in test N becomes invalid
in test N+1. Using a single session-level event loop keeps the pool alive
and valid across all tests in the session.
"""
import asyncio
from pathlib import Path

import pytest
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env", override=False)


@pytest.fixture(scope="session")
def event_loop():
    """Single event loop shared across the entire test session."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()
