"""Tests for Chromaprint fingerprinting helpers."""

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from djtoolkit.config import Config
from djtoolkit.fingerprint.chromaprint import calc, is_available, is_duplicate, lookup_acoustid, run
from djtoolkit.models.track import Track


@pytest.fixture
def cfg():
    c = Config()
    c.fingerprint.fpcalc_path = ""
    c.fingerprint.acoustid_api_key = ""
    c.fingerprint.enabled = True
    return c


def _make_track(tmp_path, *, _id=1, title="Test", artist="DJ", file_exists=True):
    """Helper to create a Track with _id set, optionally with a real file on disk."""
    if file_exists:
        fp = tmp_path / f"track_{_id}.mp3"
        fp.write_bytes(b"\x00")
        file_path = str(fp)
    else:
        file_path = str(tmp_path / f"missing_{_id}.mp3")
    track = Track(title=title, artist=artist, file_path=file_path)
    track._id = _id
    return track


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


# ─── run() with SupabaseAdapter ──────────────────────────────────────────────


class TestRun:
    """Tests for run() using mocked SupabaseAdapter."""

    @pytest.fixture
    def adapter(self):
        return MagicMock()

    def test_disabled_returns_zeros(self, cfg, adapter):
        cfg.fingerprint.enabled = False
        result = run(cfg, adapter, "user-1")
        assert result == {"fingerprinted": 0, "duplicates": 0, "skipped": 0}
        adapter.query_available_unfingerprinted.assert_not_called()

    def test_fingerprints_new_track(self, cfg, adapter, tmp_path):
        track = _make_track(tmp_path, _id=42)
        adapter.query_available_unfingerprinted.return_value = [track]
        adapter.find_fingerprint_match.return_value = None
        adapter.insert_fingerprint.return_value = 7

        with patch("djtoolkit.fingerprint.chromaprint.calc", return_value={"fingerprint": "FP123", "duration": 240.0}):
            with patch("djtoolkit.fingerprint.chromaprint.lookup_acoustid", return_value="acoust-abc"):
                result = run(cfg, adapter, "user-1")

        assert result == {"fingerprinted": 1, "duplicates": 0, "skipped": 0}
        adapter.insert_fingerprint.assert_called_once_with(
            user_id="user-1",
            track_id=42,
            fingerprint="FP123",
            acoustid="acoust-abc",
            duration=240.0,
        )
        adapter.mark_fingerprinted.assert_called_once_with(42, {"fingerprint_id": 7})

    def test_detects_duplicate(self, cfg, adapter, tmp_path):
        track = _make_track(tmp_path, _id=55)
        adapter.query_available_unfingerprinted.return_value = [track]
        adapter.find_fingerprint_match.return_value = 10  # existing track_id

        with patch("djtoolkit.fingerprint.chromaprint.calc", return_value={"fingerprint": "FP_DUP", "duration": 200.0}):
            with patch("djtoolkit.fingerprint.chromaprint.lookup_acoustid", return_value=None):
                result = run(cfg, adapter, "user-1")

        assert result == {"fingerprinted": 0, "duplicates": 1, "skipped": 0}
        adapter.update_track.assert_called_once_with(55, {
            "acquisition_status": "duplicate",
            "fingerprinted": True,
        })
        adapter.insert_fingerprint.assert_not_called()

    def test_skips_missing_file(self, cfg, adapter, tmp_path):
        track = _make_track(tmp_path, _id=99, file_exists=False)
        adapter.query_available_unfingerprinted.return_value = [track]

        result = run(cfg, adapter, "user-1")

        assert result == {"fingerprinted": 0, "duplicates": 0, "skipped": 1}
        adapter.insert_fingerprint.assert_not_called()
        adapter.update_track.assert_not_called()

    def test_skips_track_with_no_file_path(self, cfg, adapter):
        track = Track(title="No File")
        track._id = 100
        adapter.query_available_unfingerprinted.return_value = [track]

        result = run(cfg, adapter, "user-1")

        assert result == {"fingerprinted": 0, "duplicates": 0, "skipped": 1}

    def test_skips_when_calc_fails(self, cfg, adapter, tmp_path):
        track = _make_track(tmp_path, _id=77)
        adapter.query_available_unfingerprinted.return_value = [track]

        with patch("djtoolkit.fingerprint.chromaprint.calc", return_value=None):
            result = run(cfg, adapter, "user-1")

        assert result == {"fingerprinted": 0, "duplicates": 0, "skipped": 1}

    def test_empty_track_list(self, cfg, adapter):
        adapter.query_available_unfingerprinted.return_value = []

        result = run(cfg, adapter, "user-1")

        assert result == {"fingerprinted": 0, "duplicates": 0, "skipped": 0}
