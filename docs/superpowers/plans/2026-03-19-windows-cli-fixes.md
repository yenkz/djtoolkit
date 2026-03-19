# Windows CLI Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two Windows CLI issues — PyInstaller not bundling `shellingham.nt` (crashes `--install-completion`) and missing Setup Assistant GUI (falls back to interactive terminal wizard).

**Architecture:** Add `collect_submodules("shellingham")` to both PyInstaller specs. Add a `_setup_terminal_wizard()` function to `__main__.py` that uses Rich panels + Typer prompts for a 6-step interactive setup flow, reusing existing credential storage and config-writing logic.

**Tech Stack:** Python, Typer, Rich, PyInstaller, keyring

**Spec:** `docs/superpowers/specs/2026-03-19-windows-cli-fixes-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packaging/windows/djtoolkit.spec` | Modify (line 30 hiddenimports) | Add shellingham submodules |
| `packaging/macos/djtoolkit.spec` | Modify (line 29 hiddenimports) | Add shellingham submodules |
| `djtoolkit/__main__.py` | Modify (add function before line 753, rewrite lines 755-808) | Terminal wizard + setup fallback |

No new files created.

---

### Task 1: Add shellingham to Windows PyInstaller spec

**Files:**
- Modify: `packaging/windows/djtoolkit.spec:30-73` (hiddenimports list)

- [ ] **Step 1: Add shellingham collect_submodules**

In `packaging/windows/djtoolkit.spec`, add this line to the `hiddenimports` list, after the `# httpx` section (after line 64, `"httpcore",`):

```python
        # shellingham shell detection (Typer completion)
        *collect_submodules("shellingham"),
```

`collect_submodules` is already imported on line 6, so no new import needed.

- [ ] **Step 2: Commit**

```bash
git add packaging/windows/djtoolkit.spec
git commit -m "fix(windows): add shellingham to PyInstaller hiddenimports

Fixes ModuleNotFoundError for shellingham.nt when running
djtoolkit --install-completion on Windows."
```

---

### Task 2: Add shellingham to macOS PyInstaller spec

**Files:**
- Modify: `packaging/macos/djtoolkit.spec:29-67` (hiddenimports list)

- [ ] **Step 1: Add shellingham collect_submodules**

In `packaging/macos/djtoolkit.spec`, add this line to the `hiddenimports` list, after the `# httpx` section (after line 58, `"httpcore",`):

```python
        # shellingham shell detection (Typer completion)
        *collect_submodules("shellingham"),
```

`collect_submodules` is already imported on line 6.

- [ ] **Step 2: Commit**

```bash
git add packaging/macos/djtoolkit.spec
git commit -m "fix(macos): add shellingham to PyInstaller hiddenimports

Consistency with Windows spec — ensures shell completion works
in frozen builds."
```

---

### Task 3: Add `_setup_terminal_wizard()` function

**Files:**
- Modify: `djtoolkit/__main__.py` (add new function before line 753)

- [ ] **Step 1: Add the terminal wizard function**

Insert the following function before the `# ─── setup command ───` comment (before line 753). The function collects all input first, then persists at the end (no partial state on Ctrl+C).

```python
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
```

Note: `click` is a transitive dependency of `typer` — the `click.Abort` exception is what `typer.prompt()` raises on Ctrl+C. `Table` is already imported at the module level (line 8 of `__main__.py`), so no local import needed for it.

- [ ] **Step 2: Verify the function can be imported**

Run: `cd /Users/cpecile/Code/djtoolkit && poetry run python -c "from djtoolkit.__main__ import _setup_terminal_wizard; print('OK')"`

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add djtoolkit/__main__.py
git commit -m "feat: add interactive terminal setup wizard

Rich-based 6-step wizard: API key, Soulseek credentials, AcoustID,
confirm, save. Handles Ctrl+C cleanly with no partial state."
```

---

### Task 4: Update `setup_wizard()` to fall back to terminal wizard

**Files:**
- Modify: `djtoolkit/__main__.py:755-808` (the `setup_wizard` command)

- [ ] **Step 1: Rewrite `setup_wizard()` to use terminal fallback**

Replace the entire `setup_wizard()` function (lines 755-808) with this version. Key changes: (1) GUI-not-found branches call `_setup_terminal_wizard()` instead of printing an error, (2) the `else` branch (Linux) also calls the terminal wizard, (3) docstring updated.

```python
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
```

- [ ] **Step 2: Verify CLI help text**

Run: `cd /Users/cpecile/Code/djtoolkit && poetry run python -m djtoolkit setup --help`

Expected output should show the updated docstring: "Launch the Setup Assistant (GUI if available, otherwise interactive terminal wizard)."

- [ ] **Step 3: Commit**

```bash
git add djtoolkit/__main__.py
git commit -m "feat: setup command falls back to terminal wizard

When GUI Setup Assistant (.app/.exe) is not found, runs the
interactive terminal wizard instead of printing an error.
Works on all platforms including Linux."
```

---

### Task 5: Manual smoke test

- [ ] **Step 1: Test terminal wizard launches**

Run: `cd /Users/cpecile/Code/djtoolkit && poetry run python -m djtoolkit setup`

Since no `DJToolkit Setup.app` is installed at the Homebrew paths, this should launch the terminal wizard. Verify:
- Welcome panel appears
- API key prompt appears
- Invalid key (e.g., "bad") shows re-prompt
- Ctrl+C shows "Setup cancelled"

- [ ] **Step 2: Test --help still works**

Run: `cd /Users/cpecile/Code/djtoolkit && poetry run python -m djtoolkit --help`

Verify the CLI loads without errors and shows all commands.
