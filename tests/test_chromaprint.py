"""Tests for Chromaprint fingerprinting helpers."""

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from djtoolkit.config import Config
from djtoolkit.fingerprint.chromaprint import calc, is_available, is_duplicate, lookup_acoustid


@pytest.fixture
def cfg():
    c = Config()
    c.fingerprint.fpcalc_path = ""
    c.fingerprint.acoustid_api_key = ""
    c.fingerprint.enabled = True
    return c


# ─── is_available ─────────────────────────────────────────────────────────────


def test_is_available_true_when_fpcalc_in_path(cfg):
    # shutil is imported inside is_available(), so patch at the shutil module level
    with patch("shutil.which", return_value="/usr/bin/fpcalc"):
        assert is_available(cfg) is True


def test_is_available_false_when_not_found(cfg):
    with patch("shutil.which", return_value=None):
        assert is_available(cfg) is False


def test_is_available_true_when_custom_path_is_file(cfg, tmp_path):
    fpcalc_bin = tmp_path / "fpcalc"
    fpcalc_bin.write_bytes(b"fake binary")
    cfg.fingerprint.fpcalc_path = str(fpcalc_bin)
    with patch("shutil.which", return_value=None):
        assert is_available(cfg) is True


# ─── calc ─────────────────────────────────────────────────────────────────────


_FPCALC_OUTPUT = json.dumps({"fingerprint": "AAABBBCCC", "duration": 240.5})


def test_calc_returns_fingerprint_on_success(cfg, tmp_path):
    fake_file = tmp_path / "track.mp3"
    fake_file.write_bytes(b"\x00")
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = _FPCALC_OUTPUT
    with patch("djtoolkit.fingerprint.chromaprint.subprocess.run", return_value=mock_result):
        result = calc(fake_file, cfg)
    assert result is not None
    assert result["fingerprint"] == "AAABBBCCC"
    assert abs(result["duration"] - 240.5) < 0.001


def test_calc_returns_none_on_nonzero_exit(cfg, tmp_path):
    fake_file = tmp_path / "track.mp3"
    fake_file.write_bytes(b"\x00")
    mock_result = MagicMock()
    mock_result.returncode = 1
    mock_result.stdout = ""
    with patch("djtoolkit.fingerprint.chromaprint.subprocess.run", return_value=mock_result):
        result = calc(fake_file, cfg)
    assert result is None


def test_calc_returns_none_when_fpcalc_not_found(cfg, tmp_path):
    fake_file = tmp_path / "track.mp3"
    fake_file.write_bytes(b"\x00")
    with patch(
        "djtoolkit.fingerprint.chromaprint.subprocess.run",
        side_effect=FileNotFoundError(),
    ):
        result = calc(fake_file, cfg)
    assert result is None


def test_calc_returns_none_on_invalid_json(cfg, tmp_path):
    fake_file = tmp_path / "track.mp3"
    fake_file.write_bytes(b"\x00")
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "not valid json"
    with patch("djtoolkit.fingerprint.chromaprint.subprocess.run", return_value=mock_result):
        result = calc(fake_file, cfg)
    assert result is None


# ─── lookup_acoustid ──────────────────────────────────────────────────────────


def test_lookup_acoustid_returns_none_when_no_api_key(cfg):
    result = lookup_acoustid("FP123", 240.0, "")
    assert result is None


def test_lookup_acoustid_returns_recording_id(cfg):
    # acoustid is imported inside lookup_acoustid(), so patch at the acoustid module level
    recording_id = "rec-abc-123"
    with patch("acoustid.lookup", return_value={}):
        with patch(
            "acoustid.parse_lookup_result",
            return_value=[(0.95, recording_id, "Title", "Artist")],
        ):
            result = lookup_acoustid("FP123", 240.0, "test-api-key")
    assert result == recording_id


def test_lookup_acoustid_returns_none_on_empty_results(cfg):
    with patch("acoustid.lookup", return_value={}):
        with patch("acoustid.parse_lookup_result", return_value=[]):
            result = lookup_acoustid("FP123", 240.0, "test-api-key")
    assert result is None


# ─── is_duplicate ─────────────────────────────────────────────────────────────


def test_is_duplicate_identical_fingerprints():
    assert is_duplicate("AAABBBCCC", "AAABBBCCC") is True


def test_is_duplicate_different_fingerprints():
    assert is_duplicate("AAABBBCCC", "XXXYYYZZZZ") is False


def test_is_duplicate_empty_strings():
    assert is_duplicate("", "") is True
