"""Tests for audio_analysis.analyze_single()."""

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import numpy as np
import pytest

from djtoolkit.enrichment.audio_analysis import analyze_single


def _build_librosa_mock():
    """Build a comprehensive librosa mock that works with both
    `import librosa` and `__import__("librosa")` patterns."""
    mock_lr = MagicMock()
    mock_lr.load.return_value = (
        np.random.randn(44100 * 10).astype(np.float32),
        44100,
    )
    mock_lr.beat.beat_track.return_value = (
        np.array([120.0]),
        np.array([0, 22050, 44100, 66150, 88200]),
    )
    mock_lr.feature.chroma_cqt.return_value = np.random.rand(12, 100)
    mock_lr.feature.rms.return_value = np.array([[0.1]])
    mock_lr.amplitude_to_db.return_value = np.array([-20.0])
    mock_lr.feature.spectral_centroid.return_value = np.array([[2000.0]])
    mock_lr.onset.onset_detect.return_value = np.array([0, 1, 2, 3, 4])
    return mock_lr


class TestAnalyzeSingle:
    def test_returns_all_feature_keys(self, tmp_path):
        dummy_file = tmp_path / "test.mp3"
        dummy_file.write_bytes(b"\x00" * 100)

        mock_lr = _build_librosa_mock()
        mock_pyln = MagicMock()
        mock_meter = MagicMock()
        mock_meter.integrated_loudness.return_value = -8.5
        mock_pyln.Meter.return_value = mock_meter

        # Patch sys.modules so both `import librosa` and `__import__("librosa")` resolve
        with patch.dict(sys.modules, {"librosa": mock_lr, "pyloudnorm": mock_pyln}):
            result = analyze_single(dummy_file)

        assert set(result.keys()) == {"tempo", "key", "mode", "danceability", "energy", "loudness"}
        assert isinstance(result["tempo"], float)
        assert 0 <= result["key"] <= 11
        assert result["mode"] in (0, 1)
        assert 0.0 <= result["danceability"] <= 1.0
        assert 0.0 <= result["energy"] <= 1.0
        assert isinstance(result["loudness"], float)

    def test_raises_on_missing_file(self):
        with pytest.raises(FileNotFoundError):
            analyze_single(Path("/nonexistent/file.mp3"))
