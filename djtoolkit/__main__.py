"""djtoolkit CLI — Typer entry point."""

from pathlib import Path
from typing import Annotated, Optional

import typer
from rich.console import Console
from rich.table import Table

app = typer.Typer(help="djtoolkit — DJ music library manager", no_args_is_help=True)
db_app = typer.Typer(help="Database management commands")
import_app = typer.Typer(help="Import tracks into the database")
metadata_app = typer.Typer(help="Metadata commands")
coverart_app = typer.Typer(help="Cover art commands")
agent_app = typer.Typer(help="Local agent commands")
app.add_typer(db_app, name="db")
app.add_typer(import_app, name="import")
app.add_typer(metadata_app, name="metadata")
app.add_typer(coverart_app, name="coverart")
app.add_typer(agent_app, name="agent")

console = Console()

# Annotated type aliases — one fresh object per alias, no shared OptionInfo mutation
ConfigOpt = Annotated[str, typer.Option(help="Path to config file")]


def _cfg(config: str):
    from djtoolkit.config import load
    return load(config)


def _adapter():
    """Create a SupabaseAdapter from environment credentials."""
    from djtoolkit.config import _load_dotenv
    _load_dotenv()
    from djtoolkit.db.supabase_client import get_client
    from djtoolkit.adapters.supabase import SupabaseAdapter
    return SupabaseAdapter(get_client())


def _user_id() -> str:
    """Read DJTOOLKIT_USER_ID from environment."""
    import os
    uid = os.environ.get("DJTOOLKIT_USER_ID")
    if not uid:
        console.print(
            "[red]DJTOOLKIT_USER_ID not set.[/red] "
            "Set it in .env or environment. "
            "Find your user ID at [bold]djtoolkit.net/settings[/bold]."
        )
        raise typer.Exit(1)
    return uid


# ─── db commands ──────────────────────────────────────────────────────────────


@db_app.command("reset-downloading")
def db_reset_downloading(config: ConfigOpt = "djtoolkit.toml"):
    """Reset stuck 'downloading' tracks back to candidate so they can be retried."""
    adapter = _adapter()
    uid = _user_id()
    count = adapter.bulk_update_status(uid, "downloading", "candidate")
    console.print(f"[green]✓[/green] Reset [bold]{count}[/bold] stuck download(s) to candidate")


@db_app.command("purge-failed")
def db_purge_failed(
    config: ConfigOpt = "djtoolkit.toml",
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Skip confirmation")] = False,
):
    """Permanently delete all 'failed' tracks from the database."""
    adapter = _adapter()
    uid = _user_id()
    acq_counts = adapter.count_by_acquisition_status(uid)
    count = acq_counts.get("failed", 0)
    if count == 0:
        console.print("[dim]No failed tracks to delete.[/dim]")
        return
    if not yes:
        typer.confirm(f"Delete {count} failed track(s) from the database?", abort=True)
    deleted = adapter.delete_by_status(uid, "failed")
    console.print(f"[red]✗[/red] Deleted [bold]{deleted}[/bold] failed track(s)")


@db_app.command("status")
def db_status(config: ConfigOpt = "djtoolkit.toml"):
    """Show track counts by acquisition status and processing flags."""
    adapter = _adapter()
    uid = _user_id()
    acq_counts = adapter.count_by_acquisition_status(uid)
    flag_counts = adapter.count_processing_flags(uid)

    acq_table = Table("Acquisition Status", "Count", title="Tracks by Acquisition Status")
    for status, count in sorted(acq_counts.items(), key=lambda x: -x[1]):
        acq_table.add_row(status or "—", str(count))
    console.print(acq_table)

    total = flag_counts.get("total", 0)
    if total:
        flag_table = Table("Processing Flag", "Done", title="Processing Flags")
        for flag in ("fingerprinted", "enriched_spotify", "enriched_audio", "metadata_written", "normalized", "in_library"):
            n = flag_counts.get(flag, 0)
            flag_table.add_row(flag, f"{n} / {total}")
        console.print(flag_table)


# ─── import commands ──────────────────────────────────────────────────────────

@import_app.command("csv")
def import_csv(
    csv_path: Annotated[Path, typer.Argument(help="Path to Exportify CSV")],
    config: ConfigOpt = "djtoolkit.toml",
):
    """Import an Exportify CSV into the database."""
    from djtoolkit.importers.exportify import import_csv as _import
    cfg = _cfg(config)
    if not csv_path.exists():
        console.print(f"[red]File not found:[/red] {csv_path}")
        raise typer.Exit(1)
    result = _import(csv_path, _adapter(), _user_id())
    console.print(
        f"[green]✓[/green] Inserted [bold]{result['inserted']}[/bold] tracks "
        f"([yellow]{result['skipped_duplicate']}[/yellow] duplicates skipped) "
        f"from {csv_path.name}"
    )


@import_app.command("folder")
def import_folder(
    folder: Annotated[Path, typer.Argument(help="Path to folder to scan")],
    config: ConfigOpt = "djtoolkit.toml",
):
    """Scan a folder and import audio files (Flow 2)."""
    from djtoolkit.importers.folder import import_folder as _import
    cfg = _cfg(config)
    if not folder.exists():
        console.print(f"[red]Folder not found:[/red] {folder}")
        raise typer.Exit(1)
    try:
        result = _import(folder, cfg, _adapter(), _user_id())
    except RuntimeError as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(1)
    console.print(
        f"[green]✓[/green] Imported [bold]{result['inserted']}[/bold] tracks "
        f"([yellow]{result['skipped_duplicate']}[/yellow] fingerprint duplicates skipped)"
    )


@import_app.command("trackid")
def import_trackid_cmd(
    url: Annotated[str, typer.Option("--url", help="YouTube URL of DJ mix to identify")],
    force: Annotated[bool, typer.Option("--force", help="Re-submit even if URL is cached")] = False,
    config: ConfigOpt = "djtoolkit.toml",
):
    """Identify tracks in a YouTube DJ mix via TrackID.dev (Flow 3)."""
    from djtoolkit.importers.trackid import import_trackid, validate_url

    try:
        normalized = validate_url(url)
    except ValueError as e:
        console.print(f"[red]Invalid URL:[/red] {e}")
        raise typer.Exit(1)

    cfg = _cfg(config)
    console.print(f"Submitting to TrackID.dev: [bold]{normalized}[/bold]")

    try:
        stats = import_trackid(normalized, cfg, _adapter(), _user_id(), force=force)
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(1)

    if stats.get("skipped_cached"):
        console.print(
            "[yellow]URL already processed.[/yellow] Use [bold]--force[/bold] to re-submit."
        )
        return

    if stats["failed"]:
        console.print("[red]✗[/red] TrackID.dev job failed or timed out.")
        raise typer.Exit(1)

    console.print(
        f"[green]✓[/green] Imported [bold]{stats['imported']}[/bold] tracks  "
        f"[yellow]{stats['skipped_low_confidence']}[/yellow] low-confidence  "
        f"{stats['skipped_unknown']} unknown"
    )
    if stats["identified"] == 0:
        console.print("[yellow]Warning: TrackID found 0 identifiable tracks in this mix.[/yellow]")


# ─── pipeline commands ────────────────────────────────────────────────────────

@app.command()
def download(config: ConfigOpt = "djtoolkit.toml"):
    """Search Soulseek and download candidate tracks via embedded aioslsk client."""
    import logging
    from rich.logging import RichHandler
    from rich.progress import (
        Progress, SpinnerColumn, BarColumn, TextColumn,
        DownloadColumn, TransferSpeedColumn, TimeRemainingColumn,
    )
    from djtoolkit.downloader.aioslsk_client import run

    # Route log output through Rich so it renders above the live progress bars
    logging.basicConfig(
        level=logging.INFO,
        format="%(message)s",
        handlers=[RichHandler(console=console, show_path=False, show_time=False,
                              markup=True, rich_tracebacks=True)],
    )
    # Silence ALL aioslsk internal chatter at the parent logger level
    logging.getLogger("aioslsk").setLevel(logging.CRITICAL)

    cfg = _cfg(config)
    with Progress(
        SpinnerColumn(),
        TextColumn("{task.description}"),
        BarColumn(bar_width=20),
        DownloadColumn(),
        TransferSpeedColumn(),
        TimeRemainingColumn(),
        console=console,
        transient=False,
    ) as progress:
        stats = run(cfg, _adapter(), _user_id(), progress=progress)

    console.print(
        f"[green]✓ downloaded {stats['downloaded']}[/green]  "
        f"[red]✗ failed {stats['failed']}[/red]  "
        f"(attempted {stats['attempted']})"
    )


@app.command()
def fingerprint(config: ConfigOpt = "djtoolkit.toml"):
    """Run Chromaprint fingerprinting on downloaded/imported tracks."""
    from djtoolkit.fingerprint.chromaprint import run
    cfg = _cfg(config)
    console.print("Fingerprinting tracks…")
    stats = run(cfg, _adapter(), _user_id())
    console.print(
        f"[green]✓ fingerprinted {stats['fingerprinted']}[/green]  "
        f"[yellow]duplicates {stats['duplicates']}[/yellow]  "
        f"skipped {stats['skipped']}"
    )


@app.command()
def enrich(
    config: ConfigOpt = "djtoolkit.toml",
    spotify: Annotated[Optional[Path], typer.Option("--spotify", help="Exportify CSV for metadata enrichment")] = None,
    audio_analysis: Annotated[bool, typer.Option("--audio-analysis", help="Run audio analysis (BPM, key, loudness, danceability; genre/instrumental if TF models configured)")] = False,
):
    """Enrich imported tracks via Spotify CSV and/or audio analysis (Flow 2)."""
    if not spotify and not audio_analysis:
        console.print("[yellow]Specify --spotify <csv> and/or --audio-analysis[/yellow]")
        raise typer.Exit(1)
    cfg = _cfg(config)
    adapter = _adapter()
    uid = _user_id()
    if spotify:
        from djtoolkit.enrichment.spotify import run as spotify_run
        console.print(f"Enriching from Spotify CSV: {spotify}…")
        stats = spotify_run(spotify, cfg, adapter, uid)
        console.print(
            f"[green]✓ matched {stats['matched']}[/green]  "
            f"unmatched {stats['unmatched']}"
        )
    if audio_analysis:
        from djtoolkit.enrichment.audio_analysis import run as audio_run
        console.print("Running audio analysis…")
        stats = audio_run(cfg, adapter, uid)
        console.print(
            f"[green]✓ analyzed {stats['analyzed']}[/green]  "
            f"[red]failed {stats['failed']}[/red]  "
            f"skipped {stats['skipped']}"
        )


@app.command("move-to-library")
def move_to_library(
    config: ConfigOpt = "djtoolkit.toml",
    mode: Annotated[str, typer.Option("--mode", help="Filter mode: 'metadata_applied' (default) or 'imported'")] = "metadata_applied",
):
    """Move tracks into library_dir. Use --mode imported to skip the metadata_written requirement."""
    if mode not in ("metadata_applied", "imported"):
        console.print(f"[red]Invalid mode {mode!r}. Choose 'metadata_applied' or 'imported'.[/red]")
        raise typer.Exit(1)
    from djtoolkit.library.mover import run
    cfg = _cfg(config)
    console.print(f"Moving tracks to library (mode: {mode})…")
    stats = run(cfg, _adapter(), _user_id(), mode=mode)
    console.print(
        f"[green]✓ moved {stats['moved']}[/green]  "
        f"[red]failed {stats['failed']}[/red]  "
        f"skipped {stats['skipped']}  "
        f"[yellow]duplicates {stats['duplicates']}[/yellow]"
    )


@app.command()
def normalize(config: ConfigOpt = "djtoolkit.toml"):
    """Normalize loudness with ReplayGain/EBU R128."""
    console.print("[yellow]normalize: not yet implemented[/yellow]")


@app.command()
def playlist(config: ConfigOpt = "djtoolkit.toml"):
    """Generate M3U playlists grouped by genre/style."""
    console.print("[yellow]playlist: not yet implemented[/yellow]")

@app.command()
def dedup(config: ConfigOpt = "djtoolkit.toml"):
    """Remove duplicate tracks from the database."""
    console.print("[yellow]dedup: not yet implemented[/yellow]")


# ─── metadata command ─────────────────────────────────────────────────────────

@metadata_app.command("apply")
def metadata_apply(
    config: ConfigOpt = "djtoolkit.toml",
    source: Annotated[Optional[str], typer.Option(
        "--source", help="Metadata source: 'spotify' or 'audio-analysis'. Re-processes all eligible tracks with this source as authoritative.",
    )] = None,
    csv: Annotated[Optional[Path], typer.Option(
        "--csv", help="Exportify CSV path (required when --source spotify)",
    )] = None,
):
    """Write DB metadata to files and normalize filenames. Use --source to select metadata origin."""
    if source and source not in ("spotify", "audio-analysis"):
        console.print(f"[red]Invalid --source {source!r}. Choose 'spotify' or 'audio-analysis'.[/red]")
        raise typer.Exit(1)
    if source == "spotify" and not csv:
        console.print("[red]--csv is required when --source spotify[/red]")
        raise typer.Exit(1)
    if csv and not csv.exists():
        console.print(f"[red]CSV not found:[/red] {csv}")
        raise typer.Exit(1)

    from djtoolkit.metadata.writer import run
    cfg = _cfg(config)
    adapter = _adapter()
    user_id = _user_id()
    label = f"[bold]{source}[/bold]" if source else "DB (unwritten tracks)"
    console.print(f"Applying metadata to files (source: {label})…")
    stats = run(cfg, adapter, user_id, metadata_source=source, csv_path=csv)
    console.print(
        f"[green]✓ applied {stats['applied']}[/green]  "
        f"[red]failed {stats['failed']}[/red]  "
        f"skipped {stats['skipped']}"
    )


# ─── coverart commands ────────────────────────────────────────────────────────

@coverart_app.command("fetch")
def coverart_fetch(config: ConfigOpt = "djtoolkit.toml"):
    """Fetch and embed cover art for tracks that are missing artwork."""
    from djtoolkit.coverart.art import run
    cfg = _cfg(config)
    stats = run(cfg, _adapter(), _user_id())
    console.print(
        f"[green]✓ embedded {stats['embedded']}[/green]  "
        f"[red]failed {stats['failed']}[/red]  "
        f"skipped {stats['skipped']}  "
        f"[yellow]not found {stats['no_art_found']}[/yellow]"
    )


@coverart_app.command("list")
def coverart_list(
    config: ConfigOpt = "djtoolkit.toml",
    since: Annotated[Optional[int], typer.Option(
        "--since", help="Only show tracks embedded in the last N minutes"
    )] = None,
):
    """List tracks that had cover art embedded by djtoolkit."""
    adapter = _adapter()
    uid = _user_id()
    query = (
        adapter._client.table("tracks")
        .select("artist, title, album, cover_art_embedded_at")
        .eq("user_id", uid)
        .not_.is_("cover_art_embedded_at", "null")
    )
    if since is not None:
        from datetime import datetime, timezone, timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=since)).isoformat()
        query = query.gte("cover_art_embedded_at", cutoff)
    query = query.order("cover_art_embedded_at", desc=True)
    rows = query.execute().data

    if not rows:
        console.print("[dim]No tracks with embedded cover art found.[/dim]")
        return

    t = Table("Artist", "Title", "Album", "Embedded at", title=f"Cover art embedded ({len(rows)} tracks)")
    for row in rows:
        t.add_row(
            row.get("artist") or "—",
            row.get("title") or "—",
            row.get("album") or "—",
            row.get("cover_art_embedded_at") or "—",
        )
    console.print(t)


# ─── agent commands ───────────────────────────────────────────────────────────

@agent_app.command("configure")
def agent_configure(
    api_key: Annotated[str, typer.Option("--api-key", help="Agent API key (djt_xxx)")],
    cloud_url: Annotated[str, typer.Option("--cloud-url", help="Cloud API base URL")] = "https://api.djtoolkit.com",
):
    """Configure the local agent — stores credentials in the system credential store."""
    from djtoolkit.agent.keychain import store_agent_credentials, has_secret, API_KEY
    from djtoolkit.agent.paths import config_dir, credential_store_name

    if not api_key.startswith("djt_"):
        console.print("[red]API key must start with 'djt_'[/red]")
        raise typer.Exit(1)

    # Prompt for Soulseek credentials
    slsk_user = typer.prompt("Soulseek username")
    slsk_pass = typer.prompt("Soulseek password", hide_input=True)
    acoustid = typer.prompt("AcoustID API key (optional, press Enter to skip)", default="")

    store_agent_credentials(
        api_key=api_key,
        slsk_username=slsk_user,
        slsk_password=slsk_pass,
        acoustid_key=acoustid or None,
    )

    # Write non-secret config
    cfg_dir = config_dir()
    cfg_dir.mkdir(parents=True, exist_ok=True)
    config_path = cfg_dir / "config.toml"

    config_content = f"""[agent]
cloud_url = "{cloud_url}"
poll_interval_sec = 30
max_concurrent_jobs = 2

[soulseek]
search_timeout_sec = 15
download_timeout_sec = 300

[fingerprint]
enabled = true

[cover_art]
sources = "coverart itunes deezer"
"""
    config_path.write_text(config_content)

    console.print(f"[green]✓[/green] Credentials stored in {credential_store_name()}")
    console.print(f"[green]✓[/green] Config written to [bold]{config_path}[/bold]")
    console.print(f"  cloud_url = {cloud_url}")
    console.print(f"\nNext: run [bold]djtoolkit agent install[/bold] to start the background daemon.")


@agent_app.command("configure-headless")
def agent_configure_headless(
    stdin: Annotated[bool, typer.Option("--stdin", help="Read JSON config from stdin")] = False,
):
    """Non-interactive agent configuration — reads credentials from stdin JSON.

    Used by the Setup Assistant GUI. Outputs JSON to stdout.
    """
    import json as _json
    import sys as _sys
    from djtoolkit.agent.keychain import store_agent_credentials

    if not stdin:
        _sys.stdout.write(_json.dumps({
            "status": "error",
            "message": "Use --stdin to pipe JSON credentials via stdin",
        }) + "\n")
        raise typer.Exit(1)

    raw = _sys.stdin.read()

    try:
        data = _json.loads(raw)
    except _json.JSONDecodeError as e:
        _sys.stdout.write(_json.dumps({
            "status": "error",
            "message": f"Invalid input: malformed JSON — {e}",
        }) + "\n")
        raise typer.Exit(1)

    # Validate required fields
    required = ["api_key", "slsk_user", "slsk_pass"]
    for field in required:
        if field not in data or not data[field]:
            _sys.stdout.write(_json.dumps({
                "status": "error",
                "message": f"Invalid input: missing required field '{field}'",
            }) + "\n")
            raise typer.Exit(1)

    api_key = data["api_key"]
    if not api_key.startswith("djt_"):
        _sys.stdout.write(_json.dumps({
            "status": "error",
            "message": "Invalid input: api_key must start with 'djt_'",
        }) + "\n")
        raise typer.Exit(1)

    # Store credentials in system credential store
    store_agent_credentials(
        api_key=api_key,
        slsk_username=data["slsk_user"],
        slsk_password=data["slsk_pass"],
        acoustid_key=data.get("acoustid_key"),
    )

    # Write config file
    from djtoolkit.agent.paths import config_dir, default_downloads_dir
    cloud_url = data.get("cloud_url", "https://api.djtoolkit.com")
    downloads_dir = data.get("downloads_dir", str(default_downloads_dir()))
    poll_interval = data.get("poll_interval", 30)

    # Expand ~ for the response but keep unexpanded in config if user passed ~
    expanded_downloads = str(Path(downloads_dir).expanduser())

    cfg_dir = config_dir()
    cfg_dir.mkdir(parents=True, exist_ok=True)
    config_path = cfg_dir / "config.toml"

    config_content = f"""[agent]
cloud_url = "{cloud_url}"
poll_interval_sec = {poll_interval}
max_concurrent_jobs = 2
downloads_dir = "{downloads_dir}"

[soulseek]
search_timeout_sec = 15
download_timeout_sec = 300

[fingerprint]
enabled = true

[cover_art]
sources = "coverart itunes deezer"
"""
    config_path.write_text(config_content)

    _sys.stdout.write(_json.dumps({
        "status": "ok",
        "config_path": str(config_path),
        "downloads_dir": expanded_downloads,
    }) + "\n")


@agent_app.command("install")
def agent_install():
    """Install the agent as a background service (runs on login)."""
    from djtoolkit.agent.platform import get_service_manager
    from djtoolkit.agent.keychain import has_secret, API_KEY
    from djtoolkit.agent.paths import log_dir, service_display_name

    if not has_secret(API_KEY):
        console.print("[red]Agent not configured.[/red] Run [bold]djtoolkit agent configure --api-key djt_xxx[/bold] first.")
        raise typer.Exit(1)

    mgr = get_service_manager()

    if mgr.is_installed():
        console.print("[yellow]Agent already installed.[/yellow] Use [bold]djtoolkit agent start/stop[/bold] to manage.")
        return

    mgr.install()
    console.print(f"[green]✓[/green] Agent installed and started")
    console.print(f"  Logs: {log_dir() / 'agent.log'}")


@agent_app.command("uninstall")
def agent_uninstall():
    """Uninstall the agent service and clear credentials."""
    from djtoolkit.agent.platform import get_service_manager
    from djtoolkit.agent.keychain import clear_agent_credentials
    from djtoolkit.agent.paths import service_display_name, credential_store_name

    mgr = get_service_manager()

    if mgr.is_installed():
        mgr.uninstall()
        console.print(f"[green]✓[/green] {service_display_name()} removed")
    else:
        console.print(f"[dim]{service_display_name()} was not installed.[/dim]")

    if typer.confirm(f"Also remove credentials from {credential_store_name()}?", default=True):
        clear_agent_credentials()
        console.print(f"[green]✓[/green] {credential_store_name()} entries cleared")


@agent_app.command("start")
def agent_start():
    """Start the agent service."""
    from djtoolkit.agent.platform import get_service_manager
    mgr = get_service_manager()
    try:
        mgr.start()
        console.print("[green]✓[/green] Agent started")
    except FileNotFoundError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(1)


@agent_app.command("stop")
def agent_stop():
    """Stop the agent service."""
    from djtoolkit.agent.platform import get_service_manager
    mgr = get_service_manager()
    try:
        mgr.stop()
        console.print("[green]✓[/green] Agent stopped")
    except FileNotFoundError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(1)


@agent_app.command("status")
def agent_status():
    """Show agent daemon status and current activity."""
    import time
    from djtoolkit.agent.platform import get_service_manager
    from djtoolkit.agent.paths import log_dir
    from djtoolkit.agent.state import load_daemon_status

    mgr = get_service_manager()

    if not mgr.is_installed():
        console.print("[dim]Agent not installed.[/dim]")
        return

    running = mgr.is_running()
    status_str = "[green]running[/green]" if running else "[red]stopped[/red]"
    console.print(f"Agent: {status_str}")
    console.print(f"  Logs: {log_dir() / 'agent.log'}")

    if not running:
        return

    ds = load_daemon_status()
    if not ds:
        return

    age = time.time() - ds.get("updated_at", 0)
    if age > 120:
        console.print(f"  [dim]Status stale ({age:.0f}s old)[/dim]")
        return

    state = ds.get("state", "unknown")
    if state == "downloading":
        batch = ds.get("batch") or {}
        total = batch.get("total", 0)
        ok = batch.get("ok", 0)
        failed = batch.get("failed", 0)
        phase = batch.get("phase", "")
        done = ok + failed
        console.print(f"  State: [yellow]{phase}[/yellow]  ({done}/{total} tracks — {ok} ok, {failed} failed)")
    else:
        console.print(f"  State: {state}")

    totals = ds.get("totals") or {}
    if totals.get("batches", 0) > 0:
        console.print(
            f"  Session: {totals['downloaded']} downloaded, {totals['failed']} failed "
            f"across {totals['batches']} batch(es)"
        )


@agent_app.command("logs")
def agent_logs():
    """Tail the agent log file."""
    import time
    from djtoolkit.agent.paths import log_dir

    log_path = log_dir() / "agent.log"
    if not log_path.exists():
        console.print(f"[dim]Log file not found: {log_path}[/dim]")
        raise typer.Exit(1)

    try:
        with open(log_path, "r") as f:
            # Seek to last 4KB to show recent context
            f.seek(0, 2)  # end of file
            size = f.tell()
            f.seek(max(0, size - 4096))
            if size > 4096:
                f.readline()  # discard partial line
            for line in f:
                console.print(line, end="", highlight=False)
            # Tail loop
            while True:
                line = f.readline()
                if line:
                    console.print(line, end="", highlight=False)
                else:
                    time.sleep(0.5)
    except KeyboardInterrupt:
        pass


@agent_app.command("run")
def agent_run(
    config: Annotated[str | None, typer.Option(help="Path to config file")] = None,
):
    """Run the agent daemon directly (used by the service manager, not typically run manually)."""
    import asyncio
    import logging
    from djtoolkit.agent.daemon import run_daemon
    from djtoolkit.agent.paths import config_dir, log_dir

    config_path = config if config else str(config_dir() / "config.toml")

    # Use file-based logging for daemon mode
    _log_dir = log_dir()
    _log_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=[logging.FileHandler(_log_dir / "agent.log")],
    )

    cfg = _cfg(config_path)
    try:
        asyncio.run(run_daemon(cfg))
    except KeyboardInterrupt:
        pass


@agent_app.command("service-entry", hidden=True)
def agent_service_entry():
    """Entry point for the Windows Service. Not for manual use."""
    import sys as _sys
    if _sys.platform != "win32":
        console.print("[red]This command is only available on Windows.[/red]")
        raise typer.Exit(1)

    from djtoolkit.agent.windows_service import service_main
    service_main()


def _setup_terminal_wizard():
    """Interactive terminal setup wizard — fallback when GUI app is not available."""
    import click
    from rich.panel import Panel
    from djtoolkit.agent.keychain import store_agent_credentials
    from djtoolkit.agent.paths import config_dir, default_downloads_dir, credential_store_name

    # ── Step 1: Welcome ──
    console.print()
    console.print(Panel(
        "[bold]djtoolkit[/bold] — DJ music library manager\n\n"
        "This wizard will configure the local agent.\n"
        "You'll need your API key, Soulseek credentials,\n"
        "and optionally an AcoustID API key.",
        title="[bold cyan]Welcome to djtoolkit Setup[/bold cyan]",
        expand=False,
    ))
    console.print()

    while True:
        try:
            # ── Step 2: API Key ──
            console.print("[bold]Step 1/4:[/bold] API Key")
            console.print("  Get your key from the djtoolkit web dashboard.")
            console.print()
            api_key = typer.prompt("  API key (djt_xxx)")
            if not api_key.startswith("djt_"):
                console.print("[red]  API key must start with 'djt_'. Try again.[/red]")
                console.print()
                continue
            console.print()

            # ── Step 3: Soulseek ──
            console.print("[bold]Step 2/4:[/bold] Soulseek credentials")
            console.print("  Used to search and download music from the Soulseek network.")
            console.print()
            slsk_user = typer.prompt("  Soulseek username")
            slsk_pass = typer.prompt("  Soulseek password", hide_input=True)
            console.print()

            # ── Step 4: AcoustID ──
            console.print("[bold]Step 3/4:[/bold] AcoustID API key [dim](optional)[/dim]")
            console.print("  Used for audio fingerprint-based duplicate detection.")
            console.print("  Get a free key at https://acoustid.org/new-application")
            console.print()
            acoustid = typer.prompt("  AcoustID API key (Enter to skip)", default="")
            console.print()

            # ── Step 5: Confirm ──
            console.print("[bold]Step 4/4:[/bold] Confirm your settings")
            console.print()
            summary = Table(show_header=False, expand=False)
            summary.add_column("Setting", style="bold")
            summary.add_column("Value")
            summary.add_row("API key", api_key[:8] + "..." if len(api_key) > 8 else api_key)
            summary.add_row("Soulseek user", slsk_user)
            summary.add_row("Soulseek pass", "*" * len(slsk_pass))
            summary.add_row("AcoustID key", acoustid if acoustid else "[dim]skipped[/dim]")
            console.print(summary)
            console.print()

            confirm = typer.confirm("  Look good?", default=True)
            if not confirm:
                console.print()
                continue

        except click.Abort:
            console.print("\n[yellow]Setup cancelled. No changes were made.[/yellow]")
            raise typer.Exit(1)

        break

    # ── Step 6: Save and done ──
    store_agent_credentials(
        api_key=api_key,
        slsk_username=slsk_user,
        slsk_password=slsk_pass,
        acoustid_key=acoustid or None,
    )

    # Write agent config
    downloads_dir = str(default_downloads_dir())
    cfg_dir = config_dir()
    cfg_dir.mkdir(parents=True, exist_ok=True)
    config_path = cfg_dir / "config.toml"

    config_content = f"""[agent]
cloud_url = "https://api.djtoolkit.com"
poll_interval_sec = 30
max_concurrent_jobs = 2
downloads_dir = "{downloads_dir}"

[soulseek]
search_timeout_sec = 15
download_timeout_sec = 300

[fingerprint]
enabled = true

[cover_art]
sources = "coverart itunes deezer"
"""
    config_path.write_text(config_content)

    console.print()
    console.print(Panel(
        f"[green]Credentials stored in {credential_store_name()}[/green]\n"
        f"[green]Config written to {config_path}[/green]\n\n"
        f"Next: run [bold]djtoolkit agent install[/bold] to start the background service.",
        title="[bold green]Setup complete[/bold green]",
        expand=False,
    ))


# ─── setup command ────────────────────────────────────────────────────────────

@app.command("setup")
def setup_wizard():
    """Launch the Setup Assistant (GUI if available, otherwise interactive terminal wizard)."""
    import subprocess
    import sys as _sys

    if _sys.platform == "darwin":
        # Search for the .app bundle on macOS
        search_paths = [
            Path("/opt/homebrew/share/djtoolkit/DJToolkit Setup.app"),
            Path("/usr/local/share/djtoolkit/DJToolkit Setup.app"),
            Path(__file__).parent.parent / "DJToolkit Setup.app",
        ]

        app_path = None
        for p in search_paths:
            if p.exists():
                app_path = p
                break

        if app_path is None:
            _setup_terminal_wizard()
            return

        console.print("Opening Setup Assistant...")
        subprocess.run(["open", str(app_path)])

    elif _sys.platform == "win32":
        import os
        # Search for the .exe on Windows
        search_paths = [
            Path(os.environ.get("PROGRAMFILES", "C:\\Program Files")) / "djtoolkit" / "DJToolkit Setup.exe",
            Path(__file__).parent.parent / "DJToolkit Setup.exe",
        ]

        exe_path = None
        for p in search_paths:
            if p.exists():
                exe_path = p
                break

        if exe_path is None:
            _setup_terminal_wizard()
            return

        console.print("Opening Setup Assistant...")
        subprocess.run([str(exe_path)])

    else:
        _setup_terminal_wizard()


if __name__ == "__main__":
    app()
