"""Deep link handler — processes ``djtoolkit://configure?...`` URLs.

Registered as a URL scheme handler by the macOS .app bundle (Info.plist
CFBundleURLTypes) or Windows registry (set by the MSI installer).

When the user completes browser-based onboarding at djtoolkit.net/agent-connect,
the web app redirects to this URL scheme with credentials as query parameters.
"""

from __future__ import annotations

import logging
from urllib.parse import parse_qs, urlparse

log = logging.getLogger(__name__)


def handle_deeplink(url: str) -> bool:
    """Parse a djtoolkit:// URL and store credentials.

    Expected format:
        djtoolkit://configure?api_key=djt_xxx&slsk_user=foo&slsk_pass=bar
                              &supabase_url=...&supabase_anon_key=...
                              &agent_email=...&agent_password=...

    Returns True if credentials were stored successfully.
    """
    parsed = urlparse(url)

    if parsed.scheme != "djtoolkit":
        log.warning("Unexpected URL scheme: %s", parsed.scheme)
        return False

    if parsed.netloc != "configure" and parsed.hostname != "configure":
        log.warning("Unknown deep link action: %s", parsed.netloc or parsed.hostname)
        return False

    params = parse_qs(parsed.query)

    def _get(key: str) -> str | None:
        values = params.get(key)
        return values[0] if values else None

    api_key = _get("api_key")
    if not api_key or not api_key.startswith("djt_"):
        log.error("Deep link missing or invalid api_key")
        return False

    slsk_user = _get("slsk_user") or ""
    slsk_pass = _get("slsk_pass") or ""

    from djtoolkit.agent.keychain import store_agent_credentials
    from djtoolkit.agent.paths import config_dir, default_downloads_dir

    store_agent_credentials(
        api_key=api_key,
        slsk_username=slsk_user,
        slsk_password=slsk_pass,
        acoustid_key=_get("acoustid_key"),
        supabase_url=_get("supabase_url"),
        supabase_anon_key=_get("supabase_anon_key"),
        agent_email=_get("agent_email"),
        agent_password=_get("agent_password"),
    )

    # Write config file
    cloud_url = _get("cloud_url") or "https://www.djtoolkit.net"
    downloads_dir = _get("downloads_dir") or str(default_downloads_dir())
    toml_downloads_dir = downloads_dir.replace("\\", "/")

    cfg_dir = config_dir()
    cfg_dir.mkdir(parents=True, exist_ok=True)
    config_path = cfg_dir / "config.toml"

    config_content = f"""[agent]
cloud_url = "{cloud_url}"
poll_interval_sec = 60
max_concurrent_jobs = 2
downloads_dir = "{toml_downloads_dir}"
api_key = "{api_key}"
slsk_username = "{slsk_user}"

[soulseek]
search_timeout_sec = 15
download_timeout_sec = 300

[fingerprint]
enabled = true

[cover_art]
sources = "coverart itunes deezer"
"""
    config_path.write_text(config_content)

    log.info("Deep link: credentials stored, config written to %s", config_path)
    return True
