"""Tests for daemon signal handling platform branching."""
import asyncio
import sys
from unittest.mock import patch, MagicMock, AsyncMock

import pytest


@pytest.mark.asyncio
async def test_daemon_skips_signal_handlers_on_windows(monkeypatch):
    """On Windows, daemon should not call loop.add_signal_handler."""
    monkeypatch.setattr(sys, "platform", "win32")

    loop = asyncio.get_running_loop()

    from djtoolkit.agent.daemon import _setup_signal_handlers
    shutdown_event = asyncio.Event()
    _setup_signal_handlers(loop, shutdown_event)
    assert not shutdown_event.is_set()
