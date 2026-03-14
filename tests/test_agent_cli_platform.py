"""Tests for platform-aware agent CLI commands."""
import json
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from typer.testing import CliRunner

from djtoolkit.__main__ import app

runner = CliRunner()


@patch("djtoolkit.agent.platform.get_service_manager")
@patch("djtoolkit.agent.keychain.has_secret", return_value=True)
def test_agent_install_uses_platform_manager(mock_has, mock_get_mgr):
    """agent install delegates to platform service manager."""
    mock_mgr = MagicMock()
    mock_mgr.is_installed.return_value = False
    mock_mgr.install.return_value = None
    mock_get_mgr.return_value = mock_mgr

    result = runner.invoke(app, ["agent", "install"])
    assert result.exit_code == 0
    mock_mgr.install.assert_called_once()


@patch("djtoolkit.agent.platform.get_service_manager")
def test_agent_status_uses_platform_manager(mock_get_mgr):
    """agent status delegates to platform service manager."""
    mock_mgr = MagicMock()
    mock_mgr.is_installed.return_value = True
    mock_mgr.is_running.return_value = True
    mock_get_mgr.return_value = mock_mgr

    result = runner.invoke(app, ["agent", "status"])
    assert result.exit_code == 0
    assert "running" in result.stdout
