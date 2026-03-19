"""Load and validate djtoolkit.toml configuration."""

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv(env_path: str | Path = ".env") -> None:
    """Load .env file into os.environ (skips keys already set in environment)."""
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and not os.environ.get(key):
                    os.environ[key] = val
    except FileNotFoundError:
        pass


@dataclass
class DbConfig:
    path: str = "djtoolkit.db"


@dataclass
class PathsConfig:
    downloads_dir: str = "~/Soulseek/downloads/complete"
    inbox_dir: str = "~/Music/DJ/inbox"
    library_dir: str = "~/Music/DJ/library"
    beets_config: str = "~/.config/beets/config.yaml"
    scan_dir: str = ""
    candidates_csv_export: str = "djtoolkit_candidates.csv"


@dataclass
class SoulseekConfig:
    username: str = ""            # Soulseek account username
    password: str = ""            # set SOULSEEK_PASSWORD in .env
    search_timeout_sec: float = 15.0   # seconds to collect search responses
    download_timeout_sec: float = 300.0  # seconds to wait per download


@dataclass
class MatchingConfig:
    min_score: float = 0.86
    min_score_title: float = 0.70
    duration_tolerance_ms: int = 2000


@dataclass
class FingerprintConfig:
    acoustid_api_key: str = ""
    fpcalc_path: str = ""
    duration_tolerance_sec: float = 5.0
    enabled: bool = True


@dataclass
class LoudnormConfig:
    target_lufs: str = "-9"
    target_tp: str = "-1.0"
    target_lra: str = "9"


@dataclass
class CoverArtConfig:
    force: bool = False
    skip_embed: bool = False
    sources: str = "coverart itunes deezer"  # space-separated, tried in order
    minwidth: int = 800                      # reject images narrower than this (px)
    maxwidth: int = 2000                     # resize images wider than this (px, requires Pillow)
    quality: int = 90                        # JPEG quality when re-encoding after resize
    lastfm_api_key: str = ""                 # or set LASTFM_API_KEY in .env
    spotify_client_id: str = ""              # or set SPOTIFY_CLIENT_ID in .env
    spotify_client_secret: str = ""          # or set SPOTIFY_CLIENT_SECRET in .env


@dataclass
class AudioAnalysisConfig:
    models_dir: str = "~/.djtoolkit/models"
    # Embedding model — shared input for all classifiers (essentia-tensorflow optional)
    musicnn_model: str = ""           # msd-musicnn-1.pb
    # Classifier models (run on stored embeddings)
    discogs_genre_model: str = ""     # genre_discogs400-discogs-musicnn-1.pb
    discogs_genre_labels: str = ""    # genre_discogs400-discogs-musicnn-1-labels.json
    instrumental_model: str = ""      # voice_instrumental-audioset-musicnn-1.pb
    # Thresholds
    genre_top_n: int = 3
    genre_threshold: float = 0.1


@dataclass
class AgentConfig:
    cloud_url: str = "https://api.djtoolkit.com"
    api_key: str = ""           # env: DJTOOLKIT_AGENT_KEY
    poll_interval_sec: float = 30.0
    max_concurrent_jobs: int = 2
    max_download_batch: int = 50
    local_db_path: str = "~/.djtoolkit/agent.db"


@dataclass
class SupabaseConfig:
    """Supabase project settings.  All secrets come from env vars — see .env.example."""

    project_url: str = ""        # set via SUPABASE_PROJECT_URL env var or djtoolkit.toml [supabase]
    # Secrets loaded from env: SUPABASE_DATABASE_URL, SUPABASE_JWT_SECRET,
    # SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY


@dataclass
class TrackIdConfig:
    confidence_threshold: float = 0.3   # 0.0–1.0; tracks below this are skipped
    poll_interval_sec: int = 7          # seconds between status polls (clamped to 3–10 in poll_job)
    poll_timeout_sec: int = 1800        # max total poll duration in seconds; 0 = unlimited
    base_url: str = "https://trackid.dev"


@dataclass
class Config:
    db: DbConfig = field(default_factory=DbConfig)
    paths: PathsConfig = field(default_factory=PathsConfig)
    soulseek: SoulseekConfig = field(default_factory=SoulseekConfig)
    matching: MatchingConfig = field(default_factory=MatchingConfig)
    fingerprint: FingerprintConfig = field(default_factory=FingerprintConfig)
    loudnorm: LoudnormConfig = field(default_factory=LoudnormConfig)
    cover_art: CoverArtConfig = field(default_factory=CoverArtConfig)
    audio_analysis: AudioAnalysisConfig = field(default_factory=AudioAnalysisConfig)
    agent: AgentConfig = field(default_factory=AgentConfig)
    supabase: SupabaseConfig = field(default_factory=SupabaseConfig)
    trackid: TrackIdConfig = field(default_factory=TrackIdConfig)

    @property
    def db_path(self) -> Path:
        return Path(self.db.path).expanduser()

    @property
    def downloads_dir(self) -> Path:
        return Path(self.paths.downloads_dir).expanduser()

    @property
    def library_dir(self) -> Path:
        return Path(self.paths.library_dir).expanduser()

    @property
    def scan_dir(self) -> Path | None:
        return Path(self.paths.scan_dir).expanduser() if self.paths.scan_dir else None


def load(config_path: str | Path = "djtoolkit.toml") -> Config:
    """Load config from TOML file. Missing keys fall back to defaults.

    Secrets (ACOUSTID_API_KEY, SOULSEEK_PASSWORD) are read from the environment,
    with .env loaded automatically. TOML values are used as fallback.
    """
    _load_dotenv()

    path = Path(config_path)
    if not path.exists():
        cfg = Config()
    else:
        with open(path, "rb") as f:
            data = tomllib.load(f)

        def _make(cls, section):
            raw = data.get(section, {})
            fields = {k: v for k, v in raw.items() if hasattr(cls, k)}
            return cls(**fields)

        cfg = Config(
            db=_make(DbConfig, "db"),
            paths=_make(PathsConfig, "paths"),
            soulseek=_make(SoulseekConfig, "soulseek"),
            matching=_make(MatchingConfig, "matching"),
            fingerprint=_make(FingerprintConfig, "fingerprint"),
            loudnorm=_make(LoudnormConfig, "loudnorm"),
            cover_art=_make(CoverArtConfig, "cover_art"),
            audio_analysis=_make(AudioAnalysisConfig, "audio_analysis"),
            agent=_make(AgentConfig, "agent"),
            supabase=_make(SupabaseConfig, "supabase"),
            trackid=_make(TrackIdConfig, "trackid"),
        )

    # Env vars override TOML for secrets (env always wins)
    if soulseek_pw := os.environ.get("SOULSEEK_PASSWORD"):
        cfg.soulseek.password = soulseek_pw
    if acoustid_key := os.environ.get("ACOUSTID_API_KEY"):
        cfg.fingerprint.acoustid_api_key = acoustid_key
    if lastfm_key := os.environ.get("LASTFM_API_KEY"):
        cfg.cover_art.lastfm_api_key = lastfm_key
    if spotify_id := os.environ.get("SPOTIFY_CLIENT_ID"):
        cfg.cover_art.spotify_client_id = spotify_id
    if spotify_secret := os.environ.get("SPOTIFY_CLIENT_SECRET"):
        cfg.cover_art.spotify_client_secret = spotify_secret
    if agent_key := os.environ.get("DJTOOLKIT_AGENT_KEY"):
        cfg.agent.api_key = agent_key

    return cfg
