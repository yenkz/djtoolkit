"""Tests for Windows service manager (mocked pywin32)."""
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Skip entire module if not on Windows
pytestmark = pytest.mark.skipif(
    sys.platform != "win32",
    reason="Windows-only tests (pywin32 required)"
)


def test_service_name():
    from djtoolkit.agent.windows_service import SERVICE_NAME
    assert SERVICE_NAME == "DJToolkitAgent"


def test_install_returns_none():
    """install() returns None (no plist path on Windows)."""
    with patch("djtoolkit.agent.windows_service.win32serviceutil") as mock_svc:
        from djtoolkit.agent.windows_service import install
        result = install()
        assert result is None
        mock_svc.InstallService.assert_called_once()


def test_is_installed_returns_bool():
    with patch("djtoolkit.agent.windows_service.win32service") as mock_svc:
        mock_svc.OpenSCManager.return_value = MagicMock()
        from djtoolkit.agent.windows_service import is_installed
        result = is_installed()
        assert isinstance(result, bool)
