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
app.add_typer(db_app, name="db")
app.add_typer(import_app, name="import")
app.add_typer(metadata_app, name="metadata")
app.add_typer(coverart_app, name="coverart")

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


# ─── pipeline commands ────────────────────────────────────────────────────────

@app.command()
def download(config: ConfigOpt = "djtoolkit.toml"):
    """Send download_candidate tracks to slskd and poll until complete."""
    from djtoolkit.downloader.slskd import run
    cfg = _cfg(config)
    console.print("Searching and downloading via slskd…")
    stats = run(cfg)
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


if __name__ == "__main__":
    app()
