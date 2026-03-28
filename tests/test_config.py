"""Tests for config loading and dotenv helper."""

import os
from pathlib import Path

import pytest

from djtoolkit.config import Config, TrackIdConfig, _load_dotenv, load


@pytest.fixture(autouse=True)
def clean_cwd(tmp_path, monkeypatch):
    """Run each test in a temp dir so no real .env is picked up."""
    monkeypatch.chdir(tmp_path)


def test_load_missing_file_returns_defaults(tmp_path):
    cfg = load(tmp_path / "nonexistent.toml")
    assert isinstance(cfg, Config)
    assert cfg.db.path == "djtoolkit.db"
    assert cfg.soulseek.username == ""


def test_load_minimal_toml(tmp_path):
    (tmp_path / "cfg.toml").write_text('[db]\npath = "custom.db"\n')
    cfg = load(tmp_path / "cfg.toml")
    assert cfg.db.path == "custom.db"
    assert cfg.soulseek.username == ""  # default preserved


def test_load_all_sections(tmp_path):
    (tmp_path / "cfg.toml").write_text(
        '[db]\npath = "mydb.db"\n'
        '[soulseek]\nusername = "djuser"\n'
        '[matching]\nmin_score = 0.9\n'
    )
    cfg = load(tmp_path / "cfg.toml")
    assert cfg.db.path == "mydb.db"
    assert cfg.soulseek.username == "djuser"
    assert cfg.matching.min_score == 0.9


def test_db_path_property_expands_tilde(tmp_path):
    (tmp_path / "cfg.toml").write_text('[db]\npath = "~/music/tracks.db"\n')
    cfg = load(tmp_path / "cfg.toml")
    assert "~" not in str(cfg.db_path)
    assert cfg.db_path.is_absolute()


def test_library_dir_property_expands_tilde(tmp_path):
    cfg = load(tmp_path / "nonexistent.toml")
    assert "~" not in str(cfg.library_dir)
    assert cfg.library_dir.is_absolute()


def test_scan_dir_none_when_empty(tmp_path):
    cfg = load(tmp_path / "nonexistent.toml")
    assert cfg.scan_dir is None


def test_scan_dir_returns_path_when_set(tmp_path):
    (tmp_path / "cfg.toml").write_text('[paths]\nscan_dir = "/music/inbox"\n')
    cfg = load(tmp_path / "cfg.toml")
    assert cfg.scan_dir == Path("/music/inbox")


def test_unknown_toml_keys_ignored(tmp_path):
    (tmp_path / "cfg.toml").write_text('[db]\npath = "x.db"\nnonexistent_key = 42\n')
    cfg = load(tmp_path / "cfg.toml")  # must not raise
    assert cfg.db.path == "x.db"


def test_env_override_soulseek_password(tmp_path, monkeypatch):
    monkeypatch.setenv("SOULSEEK_PASSWORD", "secret123")
    cfg = load(tmp_path / "nonexistent.toml")
    assert cfg.soulseek.password == "secret123"


def test_env_override_spotify(tmp_path, monkeypatch):
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("SPOTIFY_CLIENT_SECRET", "test-secret")
    cfg = load(tmp_path / "nonexistent.toml")
    assert cfg.cover_art.spotify_client_id == "test-client-id"
    assert cfg.cover_art.spotify_client_secret == "test-secret"


def test_env_override_lastfm(tmp_path, monkeypatch):
    monkeypatch.setenv("LASTFM_API_KEY", "lfm-key")
    cfg = load(tmp_path / "nonexistent.toml")
    assert cfg.cover_art.lastfm_api_key == "lfm-key"


def test_env_beats_toml(tmp_path, monkeypatch):
    """Environment variable overrides value from TOML."""
    (tmp_path / "cfg.toml").write_text('[soulseek]\npassword = "from-toml"\n')
    monkeypatch.setenv("SOULSEEK_PASSWORD", "from-env")
    cfg = load(tmp_path / "cfg.toml")
    assert cfg.soulseek.password == "from-env"


def test_load_dotenv_loads_key_value(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text('MY_TEST_KEY="hello-world"\n')
    monkeypatch.delenv("MY_TEST_KEY", raising=False)
    _load_dotenv(env_file)
    assert os.environ.get("MY_TEST_KEY") == "hello-world"
    monkeypatch.delenv("MY_TEST_KEY", raising=False)


def test_load_dotenv_skips_comments(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("# this is a comment\nREAL_KEY_X=value\n")
    monkeypatch.delenv("REAL_KEY_X", raising=False)
    _load_dotenv(env_file)
    assert os.environ.get("REAL_KEY_X") == "value"
    monkeypatch.delenv("REAL_KEY_X", raising=False)


def test_load_dotenv_skips_already_set(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("PRESET_KEY=from_file\n")
    monkeypatch.setenv("PRESET_KEY", "already_set")
    _load_dotenv(env_file)
    assert os.environ["PRESET_KEY"] == "already_set"


def test_load_dotenv_ignores_missing_file(tmp_path):
    _load_dotenv(tmp_path / "missing.env")  # must not raise


def test_trackid_defaults():
    cfg = TrackIdConfig()
    assert cfg.confidence_threshold == 0.7
    assert cfg.poll_interval_sec == 7
    assert cfg.poll_timeout_sec == 1800
    assert cfg.api_url == "https://api.djtoolkit.net"


def test_config_has_trackid_section(tmp_path):
    cfg_path = tmp_path / "djtoolkit.toml"
    cfg_path.write_text("""
[trackid]
confidence_threshold = 0.5
poll_interval_sec = 5
""")
    cfg = load(cfg_path)
    assert cfg.trackid.confidence_threshold == 0.5
    assert cfg.trackid.poll_interval_sec == 5
    assert cfg.trackid.poll_timeout_sec == 1800  # default
