"""Tests for djtoolkit agent configure-headless command."""

import json
import subprocess
import sys
from unittest.mock import patch, MagicMock

import pytest
from typer.testing import CliRunner

from djtoolkit.__main__ import app


runner = CliRunner()


def _make_input(*, api_key="djt_abc123def456abc123def456abc123def456abc1",
                slsk_user="testuser", slsk_pass="testpass",
                acoustid_key=None, cloud_url="https://api.djtoolkit.com",
                downloads_dir="~/Music/djtoolkit/downloads",
                poll_interval=30):
    return json.dumps({
        "api_key": api_key,
        "slsk_user": slsk_user,
        "slsk_pass": slsk_pass,
        "acoustid_key": acoustid_key,
        "cloud_url": cloud_url,
        "downloads_dir": downloads_dir,
        "poll_interval": poll_interval,
    })


@patch("djtoolkit.agent.keychain.store_agent_credentials")
def test_configure_headless_valid_json(mock_store, tmp_path, monkeypatch):
    """Valid JSON via stdin → stores credentials + writes config."""
    monkeypatch.setattr("djtoolkit.agent.paths.config_dir", lambda: tmp_path / ".djtoolkit")
    input_json = _make_input()

    result = runner.invoke(app, ["agent", "configure-headless", "--stdin"],
                           input=input_json)

    assert result.exit_code == 0
    output = json.loads(result.stdout)
    assert output["status"] == "ok"
    assert "config_path" in output
    assert "downloads_dir" in output

    mock_store.assert_called_once_with(
        api_key="djt_abc123def456abc123def456abc123def456abc1",
        slsk_username="testuser",
        slsk_password="testpass",
        acoustid_key=None,
        supabase_url=None,
        supabase_anon_key=None,
        agent_email=None,
        agent_password=None,
    )

    config_path = tmp_path / ".djtoolkit" / "config.toml"
    assert config_path.exists()
    content = config_path.read_text()
    assert 'cloud_url = "https://api.djtoolkit.com"' in content
    assert "poll_interval_sec = 30" in content


@patch("djtoolkit.agent.keychain.store_agent_credentials")
def test_configure_headless_custom_settings(mock_store, tmp_path, monkeypatch):
    """Custom downloads_dir and poll_interval are written to config."""
    monkeypatch.setattr("djtoolkit.agent.paths.config_dir", lambda: tmp_path / ".djtoolkit")
    input_json = _make_input(
        downloads_dir="/Users/test/MyMusic",
        poll_interval=60,
    )

    result = runner.invoke(app, ["agent", "configure-headless", "--stdin"],
                           input=input_json)

    assert result.exit_code == 0
    config_path = tmp_path / ".djtoolkit" / "config.toml"
    content = config_path.read_text()
    assert 'downloads_dir = "/Users/test/MyMusic"' in content
    assert "poll_interval_sec = 60" in content


def test_configure_headless_malformed_json():
    """Malformed JSON → error with exit code 1."""
    result = runner.invoke(app, ["agent", "configure-headless", "--stdin"],
                           input="not valid json{{{")

    assert result.exit_code == 1
    output = json.loads(result.stdout)
    assert output["status"] == "error"
    assert "Invalid input" in output["message"]


def test_configure_headless_missing_required_field():
    """Missing required field (api_key) → error."""
    input_json = json.dumps({"slsk_user": "user", "slsk_pass": "pass"})
    # missing api_key

    result = runner.invoke(app, ["agent", "configure-headless", "--stdin"],
                           input=input_json)

    assert result.exit_code == 1
    output = json.loads(result.stdout)
    assert output["status"] == "error"
    assert "api_key" in output["message"]


def test_configure_headless_bad_api_key_prefix():
    """API key without djt_ prefix → error."""
    input_json = _make_input(api_key="bad_key_no_prefix")

    result = runner.invoke(app, ["agent", "configure-headless", "--stdin"],
                           input=input_json)

    assert result.exit_code == 1
    output = json.loads(result.stdout)
    assert output["status"] == "error"
    assert "djt_" in output["message"]
