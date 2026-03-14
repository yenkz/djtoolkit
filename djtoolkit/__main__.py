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


# ─── db commands ──────────────────────────────────────────────────────────────

@db_app.command("setup")
def db_setup(config: ConfigOpt = "djtoolkit.toml"):
    """Initialize the database schema."""
    from djtoolkit.db.database import setup
    cfg = _cfg(config)
    setup(cfg.db_path)
    console.print(f"[green]✓[/green] Database ready at [bold]{cfg.db_path}[/bold]")


@db_app.command("check")
def db_check(config: ConfigOpt = "djtoolkit.toml"):
    """Run integrity check on the database."""
    from djtoolkit.db.database import check
    cfg = _cfg(config)
    issues = check(cfg.db_path)
    if not issues:
        console.print("[green]✓[/green] Database integrity OK")
    else:
        for issue in issues:
            console.print(f"[red]✗[/red] {issue}")
        raise typer.Exit(1)


@db_app.command("migrate")
def db_migrate(config: ConfigOpt = "djtoolkit.toml"):
    """Migrate existing DB to current schema (adds acquisition_status + processing flags)."""
    from djtoolkit.db.database import migrate
    cfg = _cfg(config)
    migrate(cfg.db_path)
    console.print("[green]✓[/green] Migration complete")


@db_app.command("reconcile")
def db_reconcile(config: ConfigOpt = "djtoolkit.toml"):
    """Scan downloads_dir and library_dir and mark any already-downloaded tracks as available."""
    from djtoolkit.downloader.aioslsk_client import reconcile_disk
    cfg = _cfg(config)
    stats = reconcile_disk(cfg)
    console.print(f"[green]✓ updated {stats['updated']}[/green]  skipped {stats['skipped']}")


@db_app.command("wipe")
def db_wipe(
    config: ConfigOpt = "djtoolkit.toml",
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Skip confirmation")] = False,
):
    """Wipe all data and recreate the schema."""
    from djtoolkit.db.database import wipe
    cfg = _cfg(config)
    if not yes:
        typer.confirm(f"⚠️  Wipe all data in {cfg.db_path}?", abort=True)
    wipe(cfg.db_path)
    console.print("[yellow]Database wiped and schema recreated.[/yellow]")


@db_app.command("reset-downloading")
def db_reset_downloading(config: ConfigOpt = "djtoolkit.toml"):
    """Reset stuck 'downloading' tracks back to candidate so they can be retried."""
    from djtoolkit.db.database import connect
    cfg = _cfg(config)
    with connect(cfg.db_path) as conn:
        result = conn.execute(
            "UPDATE tracks SET acquisition_status = 'candidate' WHERE acquisition_status = 'downloading'"
        )
        count = result.rowcount
        conn.commit()
    console.print(f"[green]✓[/green] Reset [bold]{count}[/bold] stuck download(s) to candidate")


@db_app.command("purge-failed")
def db_purge_failed(
    config: ConfigOpt = "djtoolkit.toml",
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Skip confirmation")] = False,
):
    """Permanently delete all 'failed' tracks from the database."""
    from djtoolkit.db.database import connect
    cfg = _cfg(config)
    with connect(cfg.db_path) as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM tracks WHERE acquisition_status = 'failed'"
        ).fetchone()[0]
    if count == 0:
        console.print("[dim]No failed tracks to delete.[/dim]")
        return
    if not yes:
        typer.confirm(f"Delete {count} failed track(s) from the database?", abort=True)
    with connect(cfg.db_path) as conn:
        conn.execute("DELETE FROM tracks WHERE acquisition_status = 'failed'")
        conn.commit()
    console.print(f"[red]✗[/red] Deleted [bold]{count}[/bold] failed track(s)")


@db_app.command("status")
def db_status(config: ConfigOpt = "djtoolkit.toml"):
    """Show track counts by acquisition status and processing flags."""
    from djtoolkit.db.database import connect
    cfg = _cfg(config)
    with connect(cfg.db_path) as conn:
        acq_rows = conn.execute(
            "SELECT acquisition_status, COUNT(*) as n FROM tracks GROUP BY acquisition_status ORDER BY n DESC"
        ).fetchall()
        flag_rows = conn.execute("""
            SELECT
                SUM(fingerprinted)    AS fingerprinted,
                SUM(enriched_spotify) AS enriched_spotify,
                SUM(enriched_audio)   AS enriched_audio,
                SUM(metadata_written) AS metadata_written,
                SUM(normalized)       AS normalized,
                SUM(in_library)       AS in_library,
                COUNT(*)              AS total
            FROM tracks
        """).fetchone()

    acq_table = Table("Acquisition Status", "Count", title="Tracks by Acquisition Status")
    for row in acq_rows:
        acq_table.add_row(row["acquisition_status"] or "—", str(row["n"]))
    console.print(acq_table)

    if flag_rows:
        total = flag_rows["total"] or 0
        flag_table = Table("Processing Flag", "Done", title="Processing Flags")
        for flag in ("fingerprinted", "enriched_spotify", "enriched_audio", "metadata_written", "normalized", "in_library"):
            n = flag_rows[flag] or 0
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
    result = _import(csv_path, cfg.db_path)
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
        result = _import(folder, cfg)
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
        stats = import_trackid(normalized, cfg, force=force)
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
        stats = run(cfg, progress=progress)

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
    stats = run(cfg)
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
    if spotify:
        from djtoolkit.enrichment.spotify import run as spotify_run
        console.print(f"Enriching from Spotify CSV: {spotify}…")
        stats = spotify_run(spotify, cfg)
        console.print(
            f"[green]✓ matched {stats['matched']}[/green]  "
            f"unmatched {stats['unmatched']}"
        )
    if audio_analysis:
        from djtoolkit.enrichment.audio_analysis import run as audio_run
        console.print("Running audio analysis…")
        stats = audio_run(cfg)
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
    stats = run(cfg, mode=mode)
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
    label = f"[bold]{source}[/bold]" if source else "DB (unwritten tracks)"
    console.print(f"Applying metadata to files (source: {label})…")
    stats = run(cfg, metadata_source=source, csv_path=csv)
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
    stats = run(cfg)
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
    from djtoolkit.db.database import connect
    cfg = _cfg(config)
    query = """
        SELECT artist, title, album, cover_art_embedded_at
        FROM tracks
        WHERE cover_art_embedded_at IS NOT NULL
    """
    params: list = []
    if since is not None:
        query += " AND cover_art_embedded_at > datetime('now', ?)"
        params.append(f"-{since} minutes")
    query += " ORDER BY cover_art_embedded_at DESC"

    with connect(cfg.db_path) as conn:
        rows = conn.execute(query, params).fetchall()

    if not rows:
        console.print("[dim]No tracks with embedded cover art found.[/dim]")
        return

    t = Table("Artist", "Title", "Album", "Embedded at", title=f"Cover art embedded ({len(rows)} tracks)")
    for row in rows:
        t.add_row(
            row["artist"] or "—",
            row["title"] or "—",
            row["album"] or "—",
            row["cover_art_embedded_at"] or "—",
        )
    console.print(t)


# ─── agent commands ───────────────────────────────────────────────────────────

@agent_app.command("configure")
def agent_configure(
    api_key: Annotated[str, typer.Option("--api-key", help="Agent API key (djt_xxx)")],
    cloud_url: Annotated[str, typer.Option("--cloud-url", help="Cloud API base URL")] = "https://api.djtoolkit.com",
):
    """Configure the local agent — stores credentials in macOS Keychain."""
    from djtoolkit.agent.keychain import store_agent_credentials, has_secret, API_KEY

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

    # Write non-secret config to ~/.djtoolkit/config.toml
    config_dir = Path.home() / ".djtoolkit"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "config.toml"

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

    console.print(f"[green]✓[/green] Credentials stored in macOS Keychain")
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

    # Store credentials in Keychain
    store_agent_credentials(
        api_key=api_key,
        slsk_username=data["slsk_user"],
        slsk_password=data["slsk_pass"],
        acoustid_key=data.get("acoustid_key"),
    )

    # Write config file
    cloud_url = data.get("cloud_url", "https://api.djtoolkit.com")
    downloads_dir = data.get("downloads_dir", "~/Music/djtoolkit/downloads")
    poll_interval = data.get("poll_interval", 30)

    # Expand ~ for the response but keep unexpanded in config if user passed ~
    expanded_downloads = str(Path(downloads_dir).expanduser())

    config_dir = Path.home() / ".djtoolkit"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "config.toml"

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
    """Install the agent as a macOS LaunchAgent (runs on login)."""
    from djtoolkit.agent.launchd import install, is_installed
    from djtoolkit.agent.keychain import has_secret, API_KEY

    if not has_secret(API_KEY):
        console.print("[red]Agent not configured.[/red] Run [bold]djtoolkit agent configure --api-key djt_xxx[/bold] first.")
        raise typer.Exit(1)

    if is_installed():
        console.print("[yellow]Agent already installed.[/yellow] Use [bold]djtoolkit agent start/stop[/bold] to manage.")
        return

    plist_path = install()
    console.print(f"[green]✓[/green] Agent installed and started")
    console.print(f"  Plist: {plist_path}")
    console.print(f"  Logs:  ~/Library/Logs/djtoolkit/agent.log")


@agent_app.command("uninstall")
def agent_uninstall():
    """Uninstall the agent LaunchAgent and clear credentials."""
    from djtoolkit.agent.launchd import uninstall, is_installed
    from djtoolkit.agent.keychain import clear_agent_credentials

    if is_installed():
        uninstall()
        console.print("[green]✓[/green] LaunchAgent removed")
    else:
        console.print("[dim]LaunchAgent was not installed.[/dim]")

    if typer.confirm("Also remove credentials from Keychain?", default=True):
        clear_agent_credentials()
        console.print("[green]✓[/green] Keychain entries cleared")


@agent_app.command("start")
def agent_start():
    """Resume the agent (launchctl load)."""
    from djtoolkit.agent.launchd import start
    try:
        start()
        console.print("[green]✓[/green] Agent started")
    except FileNotFoundError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(1)


@agent_app.command("stop")
def agent_stop():
    """Temporarily stop the agent (launchctl unload)."""
    from djtoolkit.agent.launchd import stop
    try:
        stop()
        console.print("[green]✓[/green] Agent stopped")
    except FileNotFoundError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(1)


@agent_app.command("status")
def agent_status():
    """Show agent daemon status."""
    from djtoolkit.agent.launchd import is_installed, is_running

    if not is_installed():
        console.print("[dim]Agent not installed.[/dim]")
        return

    running = is_running()
    status_str = "[green]running[/green]" if running else "[red]stopped[/red]"
    console.print(f"Agent: {status_str}")
    console.print(f"  Logs: ~/Library/Logs/djtoolkit/agent.log")


@agent_app.command("logs")
def agent_logs():
    """Tail the agent log file."""
    import subprocess
    log_path = Path.home() / "Library" / "Logs" / "djtoolkit" / "agent.log"
    if not log_path.exists():
        console.print(f"[dim]Log file not found: {log_path}[/dim]")
        raise typer.Exit(1)
    try:
        subprocess.run(["tail", "-f", str(log_path)])
    except KeyboardInterrupt:
        pass


@agent_app.command("run")
def agent_run(
    config: ConfigOpt = str(Path.home() / ".djtoolkit" / "config.toml"),
):
    """Run the agent daemon directly (used by launchd, not typically run manually)."""
    import asyncio
    import logging
    from djtoolkit.agent.daemon import run_daemon

    # Use file-based logging for daemon mode
    log_dir = Path.home() / "Library" / "Logs" / "djtoolkit"
    log_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=[logging.FileHandler(log_dir / "agent.log")],
    )

    cfg = _cfg(config)
    asyncio.run(run_daemon(cfg))


# ─── setup command ────────────────────────────────────────────────────────────

@app.command("setup")
def setup_wizard():
    """Open the Setup Assistant GUI."""
    import platform
    import subprocess
    import shutil

    if platform.system() != "Darwin":
        console.print("[red]The Setup Assistant is only available on macOS.[/red]")
        console.print("Use [bold]djtoolkit agent configure --api-key djt_xxx[/bold] instead.")
        raise typer.Exit(1)

    # Search for the Setup Assistant app
    search_paths = [
        # Homebrew arm64
        Path("/opt/homebrew/share/djtoolkit/DJToolkit Setup.app"),
        # Homebrew x86_64
        Path("/usr/local/share/djtoolkit/DJToolkit Setup.app"),
        # Same directory as binary (DMG or dev)
        Path(__file__).parent.parent / "DJToolkit Setup.app",
    ]

    app_path = None
    for p in search_paths:
        if p.exists():
            app_path = p
            break

    if app_path is None:
        console.print("[red]Setup Assistant not found.[/red]")
        console.print("Use [bold]djtoolkit agent configure --api-key djt_xxx[/bold] for terminal setup.")
        raise typer.Exit(1)

    console.print(f"Opening Setup Assistant...")
    subprocess.run(["open", str(app_path)])


if __name__ == "__main__":
    app()
