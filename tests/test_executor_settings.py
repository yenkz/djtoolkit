"""Tests for payload.settings override in job executors."""

from djtoolkit.config import Config


def _make_cfg() -> Config:
    """Return a default Config for testing."""
    return Config()


class TestApplyDownloadSettings:
    """Test that download executor reads settings from payload."""

    def test_override_min_score(self):
        cfg = _make_cfg()
        assert cfg.matching.min_score == 0.86  # default
        assert cfg.matching.min_score_title == 0.70  # default

        from djtoolkit.agent.executor import _apply_download_settings
        _apply_download_settings(cfg, {"min_score": 0.5})
        assert cfg.matching.min_score == 0.5
        assert cfg.matching.min_score_title == 0.5

    def test_override_duration_tolerance(self):
        cfg = _make_cfg()
        from djtoolkit.agent.executor import _apply_download_settings
        _apply_download_settings(cfg, {"duration_tolerance_ms": 5000})
        assert cfg.matching.duration_tolerance_ms == 5000

    def test_override_search_timeout(self):
        cfg = _make_cfg()
        from djtoolkit.agent.executor import _apply_download_settings
        _apply_download_settings(cfg, {"search_timeout_sec": 30})
        assert cfg.soulseek.search_timeout_sec == 30

    def test_empty_settings_keeps_defaults(self):
        cfg = _make_cfg()
        original_score = cfg.matching.min_score
        from djtoolkit.agent.executor import _apply_download_settings
        _apply_download_settings(cfg, {})
        assert cfg.matching.min_score == original_score

    def test_missing_settings_key_keeps_defaults(self):
        """Backward compat: payload with no 'settings' key."""
        cfg = _make_cfg()
        original_score = cfg.matching.min_score
        from djtoolkit.agent.executor import _apply_download_settings
        _apply_download_settings(cfg, {})
        assert cfg.matching.min_score == original_score


class TestApplyCoverArtSettings:
    """Test that cover_art executor reads sources from payload."""

    def test_override_sources_with_name_mapping(self):
        from djtoolkit.agent.executor import _resolve_cover_art_sources
        cfg = _make_cfg()
        sources = _resolve_cover_art_sources(
            cfg, {"coverart_sources": ["coverartarchive", "itunes", "spotify"]}
        )
        assert sources == ["coverart", "itunes", "spotify"]

    def test_fallback_to_config_sources(self):
        from djtoolkit.agent.executor import _resolve_cover_art_sources
        cfg = _make_cfg()
        sources = _resolve_cover_art_sources(cfg, {})
        assert sources == ["coverart", "itunes", "deezer"]

    def test_unknown_sources_pass_through(self):
        from djtoolkit.agent.executor import _resolve_cover_art_sources
        cfg = _make_cfg()
        sources = _resolve_cover_art_sources(cfg, {"coverart_sources": ["newservice"]})
        assert sources == ["newservice"]
