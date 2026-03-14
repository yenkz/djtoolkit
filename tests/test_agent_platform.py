"""Tests for agent platform dispatcher."""
import sys
from unittest.mock import patch, MagicMock

import pytest

from djtoolkit.agent.platform import get_service_manager


def test_darwin_returns_launchd(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    mgr = get_service_manager()
    assert mgr.__name__ == "djtoolkit.agent.launchd"


def test_win32_returns_windows_service(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    # windows_service module can be imported on any platform (pywin32 imports are lazy)
    mgr = get_service_manager()
    assert mgr.__name__ == "djtoolkit.agent.windows_service"


def test_unsupported_platform_raises(monkeypatch):
    monkeypatch.setattr(sys, "platform", "freebsd")
    with pytest.raises(RuntimeError, match="Unsupported platform"):
        get_service_manager()
