"""Tests for cross-platform agent path resolution."""
import sys
from pathlib import Path

import pytest

from djtoolkit.agent import paths


def test_config_dir_darwin(monkeypatch):
    """macOS: config dir is ~/.djtoolkit."""
    monkeypatch.setattr(sys, "platform", "darwin")
    assert paths.config_dir() == Path.home() / ".djtoolkit"


def test_config_dir_win32(monkeypatch, tmp_path):
    """Windows: config dir is %APPDATA%/djtoolkit."""
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("APPDATA", str(tmp_path))
    assert paths.config_dir() == tmp_path / "djtoolkit"


def test_log_dir_darwin(monkeypatch):
    """macOS: log dir is ~/.djtoolkit (same as config_dir for Tauri log viewer)."""
    monkeypatch.setattr(sys, "platform", "darwin")
    assert paths.log_dir() == Path.home() / ".djtoolkit"


def test_log_dir_win32(monkeypatch, tmp_path):
    """Windows: log dir is %APPDATA%/djtoolkit (same as config_dir for Tauri log viewer)."""
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("APPDATA", str(tmp_path))
    assert paths.log_dir() == tmp_path / "djtoolkit"


def test_default_downloads_dir():
    """Default downloads dir is ~/Music/djtoolkit/downloads on all platforms."""
    assert paths.default_downloads_dir() == Path.home() / "Music" / "djtoolkit" / "downloads"


def test_credential_store_name_darwin(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    assert paths.credential_store_name() == "macOS Keychain"


def test_credential_store_name_win32(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    assert paths.credential_store_name() == "Windows Credential Manager"


def test_service_display_name_darwin(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    assert paths.service_display_name() == "LaunchAgent"


def test_service_display_name_win32(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    assert paths.service_display_name() == "service"
