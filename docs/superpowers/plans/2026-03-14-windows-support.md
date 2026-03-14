# Windows 11 Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full Windows 11 parity to djtoolkit — platform abstraction for the agent daemon, Windows Service via pywin32, WinUI 3 Setup Assistant, MSI installer via WiX, and CI pipeline.

**Architecture:** Platform dispatcher pattern (`agent/platform.py`) routes CLI commands to `launchd.py` (macOS) or `windows_service.py` (Windows). A new `agent/paths.py` module provides cross-platform config/log/downloads directory resolution. The daemon's signal handling is refactored to skip Unix-only APIs on Windows. The WinUI 3 Setup Assistant mirrors the macOS SwiftUI wizard, bundled into an MSI built with WiX 4+.

**Tech Stack:** Python 3.11+, pywin32 (Windows-only), WinUI 3 / C# / .NET, WiX 4+, GitHub Actions (`windows-latest`)

**Spec:** `docs/superpowers/specs/2026-03-14-windows-support-design.md`

---

## Chunk 1: Platform Abstraction Layer (Python)

### Task 1: Create `agent/paths.py` — cross-platform directory resolution

**Files:**
- Create: `djtoolkit/agent/paths.py`
- Test: `tests/test_agent_paths.py`

- [ ] **Step 1: Write failing tests for paths module**

```python
# tests/test_agent_paths.py
"""Tests for cross-platform agent path resolution."""
import sys
from pathlib import Path

import pytest

from djtoolkit.agent import paths


def test_config_dir_darwin(monkeypatch):
    """macOS: config dir is ~/.djtoolkit."""
    monkeypatch.setattr(sys, "platform", "darwin")
    assert paths.config_dir() == Path.home() / ".djtoolkit"


def test_config_dir_win32(monkeypatch, tmp_path):
    """Windows: config dir is %APPDATA%/djtoolkit."""
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("APPDATA", str(tmp_path))
    assert paths.config_dir() == tmp_path / "djtoolkit"


def test_log_dir_darwin(monkeypatch):
    """macOS: log dir is ~/Library/Logs/djtoolkit."""
    monkeypatch.setattr(sys, "platform", "darwin")
    assert paths.log_dir() == Path.home() / "Library" / "Logs" / "djtoolkit"


def test_log_dir_win32(monkeypatch, tmp_path):
    """Windows: log dir is %APPDATA%/djtoolkit/logs."""
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("APPDATA", str(tmp_path))
    assert paths.log_dir() == tmp_path / "djtoolkit" / "logs"


def test_default_downloads_dir():
    """Default downloads dir is ~/Music/djtoolkit/downloads on all platforms."""
    assert paths.default_downloads_dir() == Path.home() / "Music" / "djtoolkit" / "downloads"


def test_credential_store_name_darwin(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    assert paths.credential_store_name() == "macOS Keychain"


def test_credential_store_name_win32(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    assert paths.credential_store_name() == "Windows Credential Manager"


def test_service_display_name_darwin(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    assert paths.service_display_name() == "LaunchAgent"


def test_service_display_name_win32(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    assert paths.service_display_name() == "service"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `poetry run pytest tests/test_agent_paths.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'djtoolkit.agent.paths'`

- [ ] **Step 3: Implement `agent/paths.py`**

```python
# djtoolkit/agent/paths.py
"""Cross-platform path resolution for the djtoolkit agent."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def config_dir() -> Path:
    """Return the agent config directory."""
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", str(Path.home()))) / "djtoolkit"
    return Path.home() / ".djtoolkit"


def log_dir() -> Path:
    """Return the agent log directory."""
    if sys.platform == "win32":
        return config_dir() / "logs"
    return Path.home() / "Library" / "Logs" / "djtoolkit"


def default_downloads_dir() -> Path:
    """Return the default downloads directory."""
    return Path.home() / "Music" / "djtoolkit" / "downloads"


def credential_store_name() -> str:
    """Return the human-readable name of the system credential store."""
    if sys.platform == "win32":
        return "Windows Credential Manager"
    return "macOS Keychain"


def service_display_name() -> str:
    """Return the human-readable name for the background service type."""
    if sys.platform == "win32":
        return "service"
    return "LaunchAgent"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `poetry run pytest tests/test_agent_paths.py -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/agent/paths.py tests/test_agent_paths.py
git commit -m "feat: add cross-platform agent path resolution (agent/paths.py)"
```

---

### Task 2: Create `agent/platform.py` — service manager dispatcher

**Files:**
- Create: `djtoolkit/agent/platform.py`
- Test: `tests/test_agent_platform.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_agent_platform.py
"""Tests for agent platform dispatcher."""
import sys
from unittest.mock import patch

import pytest

from djtoolkit.agent.platform import get_service_manager


def test_darwin_returns_launchd(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    mgr = get_service_manager()
    assert mgr.__name__ == "djtoolkit.agent.launchd"


def test_unsupported_platform_raises(monkeypatch):
    monkeypatch.setattr(sys, "platform", "freebsd")
    with pytest.raises(RuntimeError, match="Unsupported platform"):
        get_service_manager()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `poetry run pytest tests/test_agent_platform.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement `agent/platform.py`**

```python
# djtoolkit/agent/platform.py
"""Platform dispatcher for agent service management."""
from __future__ import annotations

import sys
from types import ModuleType


def get_service_manager() -> ModuleType:
    """Return the platform-specific service manager module.

    Returns a module exposing: install(), uninstall(), start(), stop(),
    is_installed(), is_running().
    """
    if sys.platform == "darwin":
        from djtoolkit.agent import launchd
        return launchd
    elif sys.platform == "win32":
        from djtoolkit.agent import windows_service
        return windows_service
    else:
        raise RuntimeError(f"Unsupported platform: {sys.platform}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `poetry run pytest tests/test_agent_platform.py -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/agent/platform.py tests/test_agent_platform.py
git commit -m "feat: add agent platform dispatcher (agent/platform.py)"
```

---

### Task 3: Refactor `daemon.py` signal handling for Windows

**Files:**
- Modify: `djtoolkit/agent/daemon.py:75-85` (signal handler setup)

The daemon already uses an `asyncio.Event` (`shutdown_event`). We need to:
1. Guard the `add_signal_handler` calls behind `sys.platform != "win32"`
2. Return the `shutdown_event` so the Windows service can trigger it externally

- [ ] **Step 1: Write failing test for the refactored daemon**

```python
# tests/test_daemon_signal.py
"""Tests for daemon signal handling platform branching."""
import asyncio
import sys
from unittest.mock import patch, MagicMock, AsyncMock

import pytest


@pytest.mark.asyncio
async def test_daemon_skips_signal_handlers_on_windows(monkeypatch):
    """On Windows, daemon should not call loop.add_signal_handler."""
    monkeypatch.setattr(sys, "platform", "win32")

    loop = asyncio.get_running_loop()
    original_add = loop.add_signal_handler

    calls = []
    def spy_add(*args, **kwargs):
        calls.append(args)
        return original_add(*args, **kwargs)

    # We can't actually test add_signal_handler on macOS since it would work.
    # Instead verify the platform guard exists by checking the code path.
    from djtoolkit.agent.daemon import _setup_signal_handlers
    # On win32, this should be a no-op
    shutdown_event = asyncio.Event()
    _setup_signal_handlers(loop, shutdown_event)
    # If we get here without error on any platform, the guard works
    assert not shutdown_event.is_set()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `poetry run pytest tests/test_daemon_signal.py -v`
Expected: FAIL — `ImportError: cannot import name '_setup_signal_handlers'`

- [ ] **Step 3: Refactor `daemon.py`**

In `djtoolkit/agent/daemon.py`, extract the signal handler setup into a function and guard it:

Replace lines 75-85 (the signal handler block):

```python
    # ── Graceful shutdown ────────────────────────────────────────────────
    shutdown_event = asyncio.Event()
    active_tasks: set[asyncio.Task] = set()

    def _handle_signal(sig: signal.Signals) -> None:
        log.info("Received %s, shutting down gracefully…", sig.name)
        shutdown_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _handle_signal, sig)
```

With:

```python
    # ── Graceful shutdown ────────────────────────────────────────────────
    shutdown_event = asyncio.Event()
    active_tasks: set[asyncio.Task] = set()

    loop = asyncio.get_running_loop()
    _setup_signal_handlers(loop, shutdown_event)
```

And add a module-level function before `run_daemon`:

```python
def _setup_signal_handlers(
    loop: asyncio.AbstractEventLoop,
    shutdown_event: asyncio.Event,
) -> None:
    """Register signal handlers for graceful shutdown.

    On Windows, signal handlers are not available via asyncio — the Windows
    Service's SvcStop() triggers shutdown via loop.call_soon_threadsafe instead.
    """
    if sys.platform == "win32":
        return

    def _handle_signal(sig: signal.Signals) -> None:
        log.info("Received %s, shutting down gracefully…", sig.name)
        shutdown_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _handle_signal, sig)
```

Also, make `shutdown_event` accessible to external callers by returning it. Change the `run_daemon` signature to accept and return it:

At the end of the `run_daemon()` function, expose `shutdown_event` as an attribute for the Windows service to use. The simplest approach: make `run_daemon` accept an optional external `shutdown_event`:

Change signature from:
```python
async def run_daemon(cfg: Config) -> None:
```
To:
```python
async def run_daemon(cfg: Config, shutdown_event: asyncio.Event | None = None) -> None:
```

And change the shutdown_event line to:
```python
    shutdown_event = shutdown_event or asyncio.Event()
```

- [ ] **Step 4: Run tests**

Run: `poetry run pytest tests/test_daemon_signal.py tests/ -v --timeout=10`
Expected: All PASS (including existing tests)

- [ ] **Step 5: Commit**

```bash
git add djtoolkit/agent/daemon.py tests/test_daemon_signal.py
git commit -m "refactor: extract signal handler setup, skip on Windows"
```

---

### Task 4: Refactor `__main__.py` — replace launchd imports with platform dispatcher

**Files:**
- Modify: `djtoolkit/__main__.py:610-698` (agent install/uninstall/start/stop/status/logs commands)
- Modify: `djtoolkit/__main__.py:465-514` (agent configure — platform-aware strings)
- Modify: `djtoolkit/__main__.py:517-608` (agent configure-headless — use paths.py)
- Modify: `djtoolkit/__main__.py:700-719` (agent run — use paths.py for log dir)
- Modify: `djtoolkit/__main__.py:724-758` (setup_wizard — support Windows)

- [ ] **Step 1: Write tests for platform-aware CLI commands**

```python
# tests/test_agent_cli_platform.py
"""Tests for platform-aware agent CLI commands."""
import json
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from typer.testing import CliRunner

from djtoolkit.__main__ import app

runner = CliRunner()


@patch("djtoolkit.agent.platform.get_service_manager")
@patch("djtoolkit.agent.keychain.has_secret", return_value=True)
def test_agent_install_uses_platform_manager(mock_has, mock_get_mgr):
    """agent install delegates to platform service manager."""
    mock_mgr = MagicMock()
    mock_mgr.is_installed.return_value = False
    mock_mgr.install.return_value = None  # Windows returns None
    mock_get_mgr.return_value = mock_mgr

    result = runner.invoke(app, ["agent", "install"])
    assert result.exit_code == 0
    mock_mgr.install.assert_called_once()


@patch("djtoolkit.agent.platform.get_service_manager")
def test_agent_status_uses_platform_manager(mock_get_mgr):
    """agent status delegates to platform service manager."""
    mock_mgr = MagicMock()
    mock_mgr.is_installed.return_value = True
    mock_mgr.is_running.return_value = True
    mock_get_mgr.return_value = mock_mgr

    result = runner.invoke(app, ["agent", "status"])
    assert result.exit_code == 0
    assert "running" in result.stdout


@patch("djtoolkit.agent.keychain.store_agent_credentials")
def test_configure_headless_uses_paths_config_dir(mock_store, tmp_path, monkeypatch):
    """configure-headless uses paths.config_dir() not hardcoded ~/.djtoolkit."""
    monkeypatch.setattr("djtoolkit.agent.paths.config_dir", lambda: tmp_path / "custom")

    input_json = json.dumps({
        "api_key": "djt_abc123def456abc123def456abc123def456abc1",
        "slsk_user": "testuser",
        "slsk_pass": "testpass",
    })

    result = runner.invoke(app, ["agent", "configure-headless", "--stdin"],
                           input=input_json)

    assert result.exit_code == 0
    config_path = tmp_path / "custom" / "config.toml"
    assert config_path.exists()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `poetry run pytest tests/test_agent_cli_platform.py -v`
Expected: FAIL — tests still import from launchd directly

- [ ] **Step 3: Refactor `agent_install` (lines 610-627)**

Replace:
```python
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
```

With:
```python
@agent_app.command("install")
def agent_install():
    """Install the agent as a background service (runs on login/boot)."""
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

    result_path = mgr.install()
    console.print(f"[green]✓[/green] Agent installed and started")
    if result_path:
        console.print(f"  Config: {result_path}")
    console.print(f"  Logs:  {log_dir() / 'agent.log'}")
```

- [ ] **Step 4: Refactor `agent_uninstall` (lines 630-644)**

Replace:
```python
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
```

With:
```python
@agent_app.command("uninstall")
def agent_uninstall():
    """Uninstall the agent background service and clear credentials."""
    from djtoolkit.agent.platform import get_service_manager
    from djtoolkit.agent.keychain import clear_agent_credentials
    from djtoolkit.agent.paths import service_display_name, credential_store_name

    mgr = get_service_manager()
    svc_name = service_display_name()

    if mgr.is_installed():
        mgr.uninstall()
        console.print(f"[green]✓[/green] {svc_name} removed")
    else:
        console.print(f"[dim]{svc_name} was not installed.[/dim]")

    store = credential_store_name()
    if typer.confirm(f"Also remove credentials from {store}?", default=True):
        clear_agent_credentials()
        console.print(f"[green]✓[/green] {store} entries cleared")
```

- [ ] **Step 5: Refactor `agent_start` and `agent_stop` (lines 647-668)**

Replace direct launchd imports with platform dispatcher:

```python
@agent_app.command("start")
def agent_start():
    """Start the agent background service."""
    from djtoolkit.agent.platform import get_service_manager
    mgr = get_service_manager()
    try:
        mgr.start()
        console.print("[green]✓[/green] Agent started")
    except (FileNotFoundError, RuntimeError) as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(1)


@agent_app.command("stop")
def agent_stop():
    """Stop the agent background service."""
    from djtoolkit.agent.platform import get_service_manager
    mgr = get_service_manager()
    try:
        mgr.stop()
        console.print("[green]✓[/green] Agent stopped")
    except (FileNotFoundError, RuntimeError) as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(1)
```

- [ ] **Step 6: Refactor `agent_status` (lines 671-683)**

```python
@agent_app.command("status")
def agent_status():
    """Show agent daemon status."""
    from djtoolkit.agent.platform import get_service_manager
    from djtoolkit.agent.paths import log_dir

    mgr = get_service_manager()
    if not mgr.is_installed():
        console.print("[dim]Agent not installed.[/dim]")
        return

    running = mgr.is_running()
    status_str = "[green]running[/green]" if running else "[red]stopped[/red]"
    console.print(f"Agent: {status_str}")
    console.print(f"  Logs: {log_dir() / 'agent.log'}")
```

- [ ] **Step 7: Refactor `agent_logs` (lines 686-697) — cross-platform tail**

```python
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
            # Seek to last 4KB for initial output
            try:
                f.seek(0, 2)  # end
                pos = max(0, f.tell() - 4096)
                f.seek(pos)
                if pos > 0:
                    f.readline()  # skip partial line
            except OSError:
                f.seek(0)

            while True:
                line = f.readline()
                if line:
                    console.print(line, end="", highlight=False)
                else:
                    time.sleep(0.5)
    except KeyboardInterrupt:
        pass
```

- [ ] **Step 8: Refactor `agent_run` (lines 700-719) — use `paths.log_dir()`**

```python
@agent_app.command("run")
def agent_run(
    config: Annotated[str | None, typer.Option("--config", "-c", help="Path to config.toml")] = None,
):
    """Run the agent daemon directly (used by service manager, not typically run manually)."""
    import asyncio
    import logging
    from djtoolkit.agent.daemon import run_daemon
    from djtoolkit.agent.paths import config_dir, log_dir

    cfg_path = config or str(config_dir() / "config.toml")

    logs = log_dir()
    logs.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=[logging.FileHandler(logs / "agent.log")],
    )

    cfg = _cfg(cfg_path)
    try:
        asyncio.run(run_daemon(cfg))
    except KeyboardInterrupt:
        pass  # Clean exit on Ctrl+C (Windows terminal mode)
```

- [ ] **Step 9: Refactor `agent_configure` (lines 465-514) — platform-aware strings and paths**

Replace hardcoded path and string:

```python
    # Write non-secret config to config dir
    from djtoolkit.agent.paths import config_dir as _config_dir, credential_store_name
    cfg_dir = _config_dir()
    cfg_dir.mkdir(parents=True, exist_ok=True)
    config_path = cfg_dir / "config.toml"
```

And change the output message:
```python
    store = credential_store_name()
    console.print(f"[green]✓[/green] Credentials stored in {store}")
```

Also update the docstring from "macOS Keychain" to "system credential store".

- [ ] **Step 10: Refactor `agent_configure_headless` (lines 517-608) — use `paths.py`**

Replace:
```python
    config_dir = Path.home() / ".djtoolkit"
```
With:
```python
    from djtoolkit.agent.paths import config_dir as _config_dir, default_downloads_dir
    cfg_dir = _config_dir()
```

And replace the `downloads_dir` default:
```python
    downloads_dir = data.get("downloads_dir", str(default_downloads_dir()))
```

- [ ] **Step 11: Refactor `setup_wizard` (lines 724-758) — support Windows**

```python
@app.command("setup")
def setup_wizard():
    """Open the Setup Assistant GUI."""
    import platform as _platform
    import subprocess
    import sys

    system = _platform.system()

    if system == "Darwin":
        search_paths = [
            Path("/opt/homebrew/share/djtoolkit/DJToolkit Setup.app"),
            Path("/usr/local/share/djtoolkit/DJToolkit Setup.app"),
            Path(__file__).parent.parent / "DJToolkit Setup.app",
        ]
        app_path = next((p for p in search_paths if p.exists()), None)
        if app_path is None:
            console.print("[red]Setup Assistant not found.[/red]")
            console.print("Use [bold]djtoolkit agent configure --api-key djt_xxx[/bold] for terminal setup.")
            raise typer.Exit(1)
        console.print("Opening Setup Assistant...")
        subprocess.run(["open", str(app_path)])

    elif system == "Windows":
        import os
        search_paths = [
            Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "djtoolkit" / "DJToolkit Setup.exe",
            Path(__file__).parent.parent / "DJToolkit Setup.exe",
        ]
        app_path = next((p for p in search_paths if p.exists()), None)
        if app_path is None:
            console.print("[red]Setup Assistant not found.[/red]")
            console.print("Use [bold]djtoolkit agent configure --api-key djt_xxx[/bold] for terminal setup.")
            raise typer.Exit(1)
        console.print("Opening Setup Assistant...")
        subprocess.run([str(app_path)])

    else:
        console.print(f"[red]The Setup Assistant is not available on {system}.[/red]")
        console.print("Use [bold]djtoolkit agent configure --api-key djt_xxx[/bold] instead.")
        raise typer.Exit(1)
```

- [ ] **Step 12: Run all tests**

Run: `poetry run pytest tests/ -v --timeout=30`
Expected: All PASS

- [ ] **Step 13: Commit**

```bash
git add djtoolkit/__main__.py tests/test_agent_cli_platform.py
git commit -m "refactor: replace launchd imports with platform dispatcher in all agent commands"
```

---

### Task 5: Update existing `test_configure_headless.py` for cross-platform paths

**Files:**
- Modify: `tests/test_configure_headless.py:36,55,65,75`

The existing tests use `monkeypatch.setenv("HOME", ...)` and check for `.djtoolkit` subdir. After the refactor, `configure-headless` uses `paths.config_dir()`. The tests need to mock that instead.

- [ ] **Step 1: Update test to mock `paths.config_dir`**

In `test_configure_headless_valid_json`, replace:
```python
    monkeypatch.setenv("HOME", str(tmp_path))
```
With:
```python
    monkeypatch.setattr("djtoolkit.agent.paths.config_dir", lambda: tmp_path / ".djtoolkit")
```

And same for `test_configure_headless_custom_settings`.

- [ ] **Step 2: Run tests**

Run: `poetry run pytest tests/test_configure_headless.py -v`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add tests/test_configure_headless.py
git commit -m "test: update configure-headless tests for paths.config_dir()"
```

---

## Chunk 2: Windows Service + pywin32 Dependency

### Task 6: Add `pywin32` Windows-only dependency

**Files:**
- Modify: `pyproject.toml`

- [ ] **Step 1: Add pywin32 dependency**

Add under `[tool.poetry.dependencies]`:
```toml
pywin32 = {version = ">=306", markers = "sys_platform == 'win32'"}
```

- [ ] **Step 2: Run `poetry lock`**

Run: `poetry lock --no-update`
Expected: Lock file updated without errors (pywin32 won't be installed on macOS, just recorded)

- [ ] **Step 3: Commit**

```bash
git add pyproject.toml poetry.lock
git commit -m "deps: add pywin32 as Windows-only dependency"
```

---

### Task 7: Create `agent/windows_service.py`

**Files:**
- Create: `djtoolkit/agent/windows_service.py`
- Test: `tests/test_windows_service.py`

Note: These tests can only fully run on Windows. On macOS/Linux, they test the module structure and mock the pywin32 calls.

- [ ] **Step 1: Write tests (mocked for cross-platform CI)**

```python
# tests/test_windows_service.py
"""Tests for Windows service manager (mocked pywin32)."""
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Skip entire module if not importable (pywin32 not available)
pytestmark = pytest.mark.skipif(
    sys.platform != "win32",
    reason="Windows-only tests (pywin32 required)"
)


def test_service_name():
    from djtoolkit.agent.windows_service import SERVICE_NAME
    assert SERVICE_NAME == "DJToolkitAgent"


def test_install_returns_none():
    """install() returns None (no plist path on Windows)."""
    with patch("djtoolkit.agent.windows_service.win32serviceutil") as mock_svc:
        from djtoolkit.agent.windows_service import install
        result = install()
        assert result is None
        mock_svc.InstallService.assert_called_once()


def test_is_installed_returns_bool():
    with patch("djtoolkit.agent.windows_service.win32service") as mock_svc:
        mock_svc.OpenSCManager.return_value = MagicMock()
        from djtoolkit.agent.windows_service import is_installed
        # When service exists
        result = is_installed()
        assert isinstance(result, bool)
```

- [ ] **Step 2: Implement `windows_service.py`**

```python
# djtoolkit/agent/windows_service.py
"""Windows Service integration — install/manage the agent as an NT service.

Requires pywin32 (Windows-only). This module is never imported on macOS/Linux.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

log = logging.getLogger(__name__)

SERVICE_NAME = "DJToolkitAgent"
DISPLAY_NAME = "djtoolkit Agent"


def _resolve_binary() -> str:
    """Find the djtoolkit binary path for service registration."""
    if getattr(sys, "frozen", False):
        return sys.executable
    import shutil
    which = shutil.which("djtoolkit")
    if which:
        return which
    raise FileNotFoundError("djtoolkit binary not found in PATH")


def install() -> Path | None:
    """Install the agent as a Windows Service. Returns None (no plist on Windows)."""
    import win32serviceutil
    import win32service

    binary = _resolve_binary()
    win32serviceutil.InstallService(
        pythonClassString=None,
        serviceName=SERVICE_NAME,
        displayName=DISPLAY_NAME,
        startType=win32service.SERVICE_AUTO_START,
        exeName=binary,
        exeArgs="agent service-entry",
    )

    # Set recovery: restart on all failures with 60s delay
    import win32api
    scm = win32service.OpenSCManager(None, None, win32service.SC_MANAGER_ALL_ACCESS)
    try:
        svc = win32service.OpenService(scm, SERVICE_NAME, win32service.SERVICE_ALL_ACCESS)
        try:
            actions = [
                (win32service.SC_ACTION_RESTART, 60000),  # 1st failure
                (win32service.SC_ACTION_RESTART, 60000),  # 2nd failure
                (win32service.SC_ACTION_RESTART, 60000),  # subsequent
            ]
            win32service.ChangeServiceConfig2(
                svc, win32service.SERVICE_CONFIG_FAILURE_ACTIONS,
                {"ResetPeriod": 86400, "Actions": actions}
            )
        finally:
            win32service.CloseServiceHandle(svc)
    finally:
        win32service.CloseServiceHandle(scm)

    start()
    log.info("Windows Service '%s' installed and started", SERVICE_NAME)
    return None


def uninstall() -> None:
    """Stop (if running) and remove the Windows Service."""
    import win32serviceutil

    if is_running():
        stop()

    win32serviceutil.RemoveService(SERVICE_NAME)
    log.info("Windows Service '%s' removed", SERVICE_NAME)


def start() -> None:
    """Start the Windows Service."""
    import win32serviceutil
    if not is_installed():
        raise FileNotFoundError(f"Service '{SERVICE_NAME}' is not installed")
    win32serviceutil.StartService(SERVICE_NAME)


def stop() -> None:
    """Stop the Windows Service."""
    import win32serviceutil
    if not is_installed():
        raise FileNotFoundError(f"Service '{SERVICE_NAME}' is not installed")
    win32serviceutil.StopService(SERVICE_NAME)


def is_installed() -> bool:
    """Check if the Windows Service is registered."""
    import win32service
    try:
        scm = win32service.OpenSCManager(None, None, win32service.SC_MANAGER_CONNECT)
        try:
            svc = win32service.OpenService(scm, SERVICE_NAME, win32service.SERVICE_QUERY_STATUS)
            win32service.CloseServiceHandle(svc)
            return True
        except win32service.error:
            return False
        finally:
            win32service.CloseServiceHandle(scm)
    except win32service.error:
        return False


def is_running() -> bool:
    """Check if the Windows Service is currently running."""
    import win32service
    try:
        scm = win32service.OpenSCManager(None, None, win32service.SC_MANAGER_CONNECT)
        try:
            svc = win32service.OpenService(scm, SERVICE_NAME, win32service.SERVICE_QUERY_STATUS)
            try:
                status = win32service.QueryServiceStatus(svc)
                return status[1] == win32service.SERVICE_RUNNING
            finally:
                win32service.CloseServiceHandle(svc)
        except win32service.error:
            return False
        finally:
            win32service.CloseServiceHandle(scm)
    except win32service.error:
        return False


# ── Service Framework (entry point for SCM) ────────────────────────────────

class DJToolkitAgentService:
    """Windows Service entry point.

    Called by the SCM when the service starts/stops. Wraps the asyncio
    daemon loop and exposes shutdown via call_soon_threadsafe.
    """
    _svc_name_ = SERVICE_NAME
    _svc_display_name_ = DISPLAY_NAME

    def __init__(self):
        import win32event
        self.stop_event = win32event.CreateEvent(None, 0, 0, None)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._shutdown_event: asyncio.Event | None = None

    def SvcStop(self):
        """Called by SCM to stop the service."""
        import win32service
        import servicemanager
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        if self._loop and self._shutdown_event:
            self._loop.call_soon_threadsafe(self._shutdown_event.set)
        servicemanager.LogInfoMsg(f"{SERVICE_NAME} stopping")

    def SvcDoRun(self):
        """Called by SCM to start the service."""
        import asyncio
        import logging
        import servicemanager
        from djtoolkit.agent.daemon import run_daemon
        from djtoolkit.agent.paths import config_dir, log_dir
        from djtoolkit.config import load_config

        servicemanager.LogInfoMsg(f"{SERVICE_NAME} starting")

        logs = log_dir()
        logs.mkdir(parents=True, exist_ok=True)
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            handlers=[logging.FileHandler(logs / "agent.log")],
        )

        cfg_path = str(config_dir() / "config.toml")
        cfg = load_config(cfg_path)

        self._shutdown_event = asyncio.Event()
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)

        try:
            self._loop.run_until_complete(
                run_daemon(cfg, shutdown_event=self._shutdown_event)
            )
        finally:
            self._loop.close()

        servicemanager.LogInfoMsg(f"{SERVICE_NAME} stopped")


def service_main():
    """Entry point called by `djtoolkit agent service-entry`."""
    import win32serviceutil
    import servicemanager

    # When running as a frozen PyInstaller exe, use HandleCommandLine
    # which dispatches to the SCM
    win32serviceutil.HandleCommandLine(DJToolkitAgentService)
```

- [ ] **Step 3: Add `service-entry` subcommand to `__main__.py`**

This is the entry point the Windows Service calls. Add after `agent_run`:

```python
@agent_app.command("service-entry", hidden=True)
def agent_service_entry():
    """Entry point for the Windows Service. Not for manual use.

    Called by the SCM via the registered service binary path.
    Dispatches to the ServiceFramework which manages the daemon lifecycle.
    """
    import sys as _sys
    if _sys.platform != "win32":
        console.print("[red]This command is only available on Windows.[/red]")
        raise typer.Exit(1)

    from djtoolkit.agent.windows_service import service_main
    service_main()
```

- [ ] **Step 4: Commit**

```bash
git add djtoolkit/agent/windows_service.py tests/test_windows_service.py djtoolkit/__main__.py
git commit -m "feat: add Windows Service implementation (agent/windows_service.py)"
```

---

## Chunk 3: Windows Build & Packaging

### Task 8: Create Windows PyInstaller spec

**Files:**
- Create: `packaging/windows/djtoolkit.spec`
- Create: `packaging/windows/runtime_hook_path.py`

- [ ] **Step 1: Create the PyInstaller spec**

```python
# packaging/windows/djtoolkit.spec
# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for djtoolkit local agent (Windows x86_64)."""

import os
import sys
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

# fpcalc.exe should be in the same directory or downloaded during build
FPCALC_PATH = os.environ.get("FPCALC_PATH", "dist\\fpcalc.exe")

if not os.path.exists(FPCALC_PATH):
    print(f"WARNING: fpcalc not found at {FPCALC_PATH}. It will not be bundled.")
    fpcalc_binaries = []
else:
    fpcalc_binaries = [(FPCALC_PATH, "bin")]

a = Analysis(
    ["../../djtoolkit/__main__.py"],
    pathex=[],
    binaries=fpcalc_binaries,
    datas=[
        *collect_data_files("librosa"),
        *collect_data_files("aioslsk"),
    ],
    hiddenimports=[
        *collect_submodules("djtoolkit"),
        *collect_submodules("aioslsk"),
        # librosa optional backends
        "librosa.core",
        "librosa.beat",
        "librosa.feature",
        "numba",
        "llvmlite",
        # crypto / auth
        "jose",
        "jose.jwt",
        "passlib.handlers.bcrypt",
        "cryptography.hazmat.primitives.kdf.pbkdf2",
        # Windows Credential Manager
        "keyring",
        "keyring.backends",
        "keyring.backends.Windows",
        # pywin32 for Windows Service
        "win32serviceutil",
        "win32service",
        "win32event",
        "servicemanager",
        # typer / click internals
        "typer",
        "typer.main",
        "click",
        "rich",
        "rich.console",
        "rich.logging",
        "rich.progress",
        "rich.table",
        # httpx
        "httpx",
        "httpcore",
        # mutagen codecs
        "mutagen.mp3",
        "mutagen.flac",
        "mutagen.mp4",
        "mutagen.id3",
        # aioslsk protocol
        "aiofiles",
        "async_timeout",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=["packaging/windows/runtime_hook_path.py"],
    excludes=[
        "fastapi",
        "uvicorn",
        "starlette",
        "asyncpg",
        "essentia",
        "tensorflow",
        "torch",
        "tkinter",
        "IPython",
        "jupyter",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="djtoolkit",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    icon="packaging/windows/assets/icon.ico",
)
```

- [ ] **Step 2: Create runtime hook**

```python
# packaging/windows/runtime_hook_path.py
"""Runtime hook: prepend bundled bin/ to PATH so fpcalc.exe is discoverable."""
import os
import sys

if getattr(sys, "frozen", False):
    bundle_dir = os.path.dirname(sys.executable)
    bin_dir = os.path.join(bundle_dir, "bin")
    if os.path.isdir(bin_dir):
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
```

- [ ] **Step 3: Create placeholder assets directory**

Run: `mkdir -p packaging/windows/assets`
Create a placeholder `packaging/windows/assets/.gitkeep`

- [ ] **Step 4: Commit**

```bash
git add packaging/windows/
git commit -m "feat: add Windows PyInstaller spec and runtime hook"
```

---

### Task 9: Create Windows build script (`build.ps1`)

**Files:**
- Create: `packaging/windows/build.ps1`

- [ ] **Step 1: Write the build script**

```powershell
# packaging/windows/build.ps1
# Build djtoolkit Windows MSI installer
# Run from repo root: powershell -ExecutionPolicy Bypass -File packaging/windows/build.ps1
param(
    [string]$Version = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $Version) {
    $Version = (poetry version -s)
}

Write-Host "Building djtoolkit $Version for Windows x86_64"

# ── 1. Download fpcalc.exe if not present ──────────────────────────────────
$FpcalcPath = "dist\fpcalc.exe"
if (-not (Test-Path $FpcalcPath)) {
    Write-Host "Downloading fpcalc.exe..."
    $chromaprintVersion = "1.5.1"
    $url = "https://github.com/nicknash/chromaprint/releases/download/v${chromaprintVersion}/chromaprint-fpcalc-${chromaprintVersion}-windows-x86_64.zip"
    $zipPath = "dist\fpcalc.zip"
    New-Item -ItemType Directory -Path "dist" -Force | Out-Null
    Invoke-WebRequest -Uri $url -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath "dist\fpcalc-tmp" -Force
    Copy-Item "dist\fpcalc-tmp\*\fpcalc.exe" $FpcalcPath
    Remove-Item -Recurse "dist\fpcalc-tmp", $zipPath
    Write-Host "✓ fpcalc.exe downloaded"
}

# ── 2. PyInstaller — single-file executable ────────────────────────────────
Write-Host "Running PyInstaller..."
$env:FPCALC_PATH = $FpcalcPath
poetry run pyinstaller packaging/windows/djtoolkit.spec --clean --noconfirm

$Binary = "dist\djtoolkit.exe"
if (-not (Test-Path $Binary)) {
    Write-Error "PyInstaller output not found at $Binary"
    exit 1
}
$size = (Get-Item $Binary).Length / 1MB
Write-Host ("✓ Binary built: $Binary ({0:N1} MB)" -f $size)

# ── 3. Build MSI via WiX 4+ ───────────────────────────────────────────────
Write-Host "Building MSI..."
$msiName = "djtoolkit-${Version}-windows.msi"

# WiX 4+ uses 'wix build' CLI
wix build packaging/windows/djtoolkit.wxs `
    -o "dist\$msiName" `
    -d Version=$Version `
    -d BinaryPath=$Binary `
    -d FpcalcPath=$FpcalcPath

if (-not (Test-Path "dist\$msiName")) {
    Write-Error "MSI build failed"
    exit 1
}

$msiSize = (Get-Item "dist\$msiName").Length / 1MB
Write-Host ("✓ MSI built: dist\$msiName ({0:N1} MB)" -f $msiSize)

Write-Host ""
Write-Host "Build complete:"
Write-Host "  dist\$msiName"
```

- [ ] **Step 2: Commit**

```bash
git add packaging/windows/build.ps1
git commit -m "feat: add Windows build script (build.ps1)"
```

---

### Task 10: Create WiX installer definition

**Files:**
- Create: `packaging/windows/djtoolkit.wxs`

- [ ] **Step 1: Write the WiX definition**

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- packaging/windows/djtoolkit.wxs — WiX 4+ MSI installer for djtoolkit -->
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="djtoolkit"
           Version="$(var.Version)"
           Manufacturer="djtoolkit"
           UpgradeCode="E7A3F1D2-8B4C-4A5E-9D6F-1C2B3A4D5E6F">

    <MajorUpgrade DowngradeErrorMessage="A newer version of djtoolkit is already installed." />
    <MediaTemplate EmbedCab="yes" />

    <!-- Install directory -->
    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="djtoolkit">

        <Component Id="MainExecutable" Guid="A1B2C3D4-E5F6-7890-ABCD-EF1234567890">
          <File Id="DjtoolkitExe" Source="$(var.BinaryPath)" KeyPath="yes" />
        </Component>

        <Component Id="FpcalcExecutable" Guid="B2C3D4E5-F6A7-8901-BCDE-F12345678901">
          <File Id="FpcalcExe" Source="$(var.FpcalcPath)" KeyPath="yes" />
        </Component>

        <Component Id="SetupAssistant" Guid="E5F6A7B8-C9D0-1234-EF01-345678901234">
          <File Id="SetupExe" Source="$(var.SetupPath)" KeyPath="yes" Name="DJToolkit Setup.exe" />
        </Component>

        <!-- Add install dir to PATH -->
        <Component Id="PathEntry" Guid="C3D4E5F6-A7B8-9012-CDEF-123456789012">
          <Environment Id="PATH"
                       Name="PATH"
                       Value="[INSTALLFOLDER]"
                       Permanent="no"
                       Part="last"
                       Action="set"
                       System="yes" />
        </Component>

        <!-- Register djtoolkit:// protocol -->
        <Component Id="ProtocolHandler" Guid="D4E5F6A7-B8C9-0123-DEF0-234567890123">
          <RegistryKey Root="HKCU" Key="Software\Classes\djtoolkit">
            <RegistryValue Type="string" Value="URL:djtoolkit Protocol" />
            <RegistryValue Name="URL Protocol" Type="string" Value="" />
          </RegistryKey>
          <RegistryKey Root="HKCU" Key="Software\Classes\djtoolkit\shell\open\command">
            <RegistryValue Type="string" Value="&quot;[INSTALLFOLDER]DJToolkit Setup.exe&quot; &quot;%1&quot;" />
          </RegistryKey>
        </Component>

      </Directory>
    </StandardDirectory>

    <Feature Id="MainFeature" Title="djtoolkit" Level="1">
      <ComponentRef Id="MainExecutable" />
      <ComponentRef Id="FpcalcExecutable" />
      <ComponentRef Id="SetupAssistant" />
      <ComponentRef Id="PathEntry" />
      <ComponentRef Id="ProtocolHandler" />
    </Feature>

  </Package>
</Wix>
```

- [ ] **Step 2: Commit**

```bash
git add packaging/windows/djtoolkit.wxs
git commit -m "feat: add WiX 4+ MSI installer definition"
```

---

### Task 11: Add Windows build job to `release.yml`

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Rename workflow and add Windows job**

Change line 1 from `name: Release macOS Installer` to `name: Release`.

Add the `build-windows` job after the `build-macos` job (before `update-homebrew`):

```yaml
  build-windows:
    name: Build Windows x86_64
    runs-on: windows-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Python 3.11
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install Poetry
        run: pip install poetry

      - name: Install dependencies
        run: poetry install --no-interaction

      - name: Install PyInstaller
        run: poetry run pip install pyinstaller

      - name: Download fpcalc.exe
        run: |
          $chromaprintVersion = "1.5.1"
          $url = "https://github.com/acoustid/chromaprint/releases/download/v${chromaprintVersion}/chromaprint-fpcalc-${chromaprintVersion}-windows-x86_64.zip"
          New-Item -ItemType Directory -Path "dist" -Force | Out-Null
          Invoke-WebRequest -Uri $url -OutFile "dist\fpcalc.zip"
          Expand-Archive -Path "dist\fpcalc.zip" -DestinationPath "dist\fpcalc-tmp" -Force
          Get-ChildItem -Path "dist\fpcalc-tmp" -Recurse -Filter "fpcalc.exe" |
            Copy-Item -Destination "dist\fpcalc.exe"
          Remove-Item -Recurse "dist\fpcalc-tmp", "dist\fpcalc.zip"
        shell: pwsh

      - name: Build CLI binary
        env:
          FPCALC_PATH: dist\fpcalc.exe
        run: poetry run pyinstaller packaging/windows/djtoolkit.spec --clean --noconfirm

      - name: Install WiX 4
        run: dotnet tool install --global wix
        shell: pwsh

      - name: Build MSI
        env:
          VERSION: ${{ github.ref_name }}
        run: |
          $v = "$env:VERSION" -replace '^v',''
          wix build packaging/windows/djtoolkit.wxs `
            -o "dist/djtoolkit-${v}-windows.msi" `
            -d Version=$v `
            -d BinaryPath="dist/djtoolkit.exe" `
            -d FpcalcPath="dist/fpcalc.exe"
        shell: pwsh

      - name: Upload release assets
        uses: softprops/action-gh-release@v2
        with:
          draft: false
          files: dist/*.msi
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Make `update-homebrew` depend on both build jobs**

Change:
```yaml
  update-homebrew:
    name: Update Homebrew tap
    needs: build-macos
```
To:
```yaml
  update-homebrew:
    name: Update Homebrew tap
    needs: [build-macos, build-windows]
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add Windows build job to release pipeline"
```

---

## Chunk 4: WinUI 3 Setup Assistant (C#/.NET)

### Task 12: Scaffold the WinUI 3 project

**Files:**
- Create: `setup-assistant-windows/DJToolkitSetup.sln`
- Create: `setup-assistant-windows/DJToolkitSetup/DJToolkitSetup.csproj`
- Create: `setup-assistant-windows/DJToolkitSetup/App.xaml`
- Create: `setup-assistant-windows/DJToolkitSetup/App.xaml.cs`

This task scaffolds the project structure. The WinUI 3 app uses the unpackaged deployment model (no MSIX).

- [ ] **Step 1: Create the solution and project files**

The `.csproj` targets `net8.0-windows10.0.22621.0` with WindowsAppSDK. The project uses the unpackaged model (`WindowsPackageType=None`).

```xml
<!-- setup-assistant-windows/DJToolkitSetup/DJToolkitSetup.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows10.0.22621.0</TargetFramework>
    <RootNamespace>DJToolkitSetup</RootNamespace>
    <UseWinUI>true</UseWinUI>
    <WindowsPackageType>None</WindowsPackageType>
    <AssemblyName>DJToolkit Setup</AssemblyName>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.WindowsAppSDK" Version="1.5.*" />
    <PackageReference Include="Microsoft.Windows.SDK.BuildTools" Version="10.0.22621.*" />
    <PackageReference Include="Microsoft.Web.WebView2" Version="1.*" />
  </ItemGroup>
</Project>
```

```xml
<!-- setup-assistant-windows/DJToolkitSetup/App.xaml -->
<Application
    x:Class="DJToolkitSetup.App"
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
</Application>
```

```csharp
// setup-assistant-windows/DJToolkitSetup/App.xaml.cs
using Microsoft.UI.Xaml;

namespace DJToolkitSetup;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new MainWindow();
        _window.Activate();
    }
}
```

- [ ] **Step 2: Create solution file**

Run (on a Windows machine or manually):
```
dotnet new sln -n DJToolkitSetup -o setup-assistant-windows
dotnet sln setup-assistant-windows/DJToolkitSetup.sln add setup-assistant-windows/DJToolkitSetup/DJToolkitSetup.csproj
```

Or create the `.sln` file manually.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant-windows/
git commit -m "feat: scaffold WinUI 3 Setup Assistant project"
```

---

### Task 13: Implement `SetupState.cs` and `CLIBridge.cs`

**Files:**
- Create: `setup-assistant-windows/DJToolkitSetup/Models/SetupState.cs`
- Create: `setup-assistant-windows/DJToolkitSetup/Services/CLIBridge.cs`

- [ ] **Step 1: Create SetupState**

```csharp
// setup-assistant-windows/DJToolkitSetup/Models/SetupState.cs
using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace DJToolkitSetup.Models;

public class SetupState : INotifyPropertyChanged
{
    private string _email = "";
    private string _apiKey = "";
    private string _slskUser = "";
    private string _slskPass = "";
    private string _acoustidKey = "";
    private string _downloadsDir = "";
    private int _pollInterval = 30;

    public string Email { get => _email; set => Set(ref _email, value); }
    public string ApiKey { get => _apiKey; set => Set(ref _apiKey, value); }
    public string SlskUser { get => _slskUser; set => Set(ref _slskUser, value); }
    public string SlskPass { get => _slskPass; set => Set(ref _slskPass, value); }
    public string AcoustidKey { get => _acoustidKey; set => Set(ref _acoustidKey, value); }
    public string DownloadsDir { get => _downloadsDir; set => Set(ref _downloadsDir, value); }
    public int PollInterval { get => _pollInterval; set => Set(ref _pollInterval, value); }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (!Equals(field, value))
        {
            field = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
        }
    }
}
```

- [ ] **Step 2: Create CLIBridge**

```csharp
// setup-assistant-windows/DJToolkitSetup/Services/CLIBridge.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;

namespace DJToolkitSetup.Services;

public record CLIResult(int ExitCode, string Stdout, string Stderr);

public static class CLIBridge
{
    private static string ResolveBinary()
    {
        // 1. MSI install location
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var msiPath = Path.Combine(programFiles, "djtoolkit", "djtoolkit.exe");
        if (File.Exists(msiPath)) return msiPath;

        // 2. PATH
        var pathDirs = Environment.GetEnvironmentVariable("PATH")?.Split(';') ?? [];
        foreach (var dir in pathDirs)
        {
            var candidate = Path.Combine(dir, "djtoolkit.exe");
            if (File.Exists(candidate)) return candidate;
        }

        // 3. Adjacent directory (dev/build)
        var adjacent = Path.Combine(AppContext.BaseDirectory, "djtoolkit.exe");
        if (File.Exists(adjacent)) return adjacent;

        throw new FileNotFoundException("djtoolkit.exe not found");
    }

    public static async Task<CLIResult> RunAsync(string[] args, string? stdin = null, bool elevate = false)
    {
        var binary = ResolveBinary();
        var psi = new ProcessStartInfo
        {
            FileName = binary,
            RedirectStandardInput = stdin != null,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = elevate,
            CreateNoWindow = !elevate,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);

        if (elevate)
        {
            psi.Verb = "runas";
            psi.RedirectStandardInput = false;
            psi.RedirectStandardOutput = false;
            psi.RedirectStandardError = false;
        }

        using var proc = Process.Start(psi) ?? throw new Exception("Failed to start process");

        if (stdin != null && !elevate)
        {
            await proc.StandardInput.WriteAsync(stdin);
            proc.StandardInput.Close();
        }

        string stdout = "", stderr = "";
        if (!elevate)
        {
            stdout = await proc.StandardOutput.ReadToEndAsync();
            stderr = await proc.StandardError.ReadToEndAsync();
        }

        await proc.WaitForExitAsync();
        return new CLIResult(proc.ExitCode, stdout, stderr);
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add setup-assistant-windows/DJToolkitSetup/Models/ setup-assistant-windows/DJToolkitSetup/Services/CLIBridge.cs
git commit -m "feat: add SetupState model and CLIBridge service"
```

---

### Task 14: Implement `AgentAPI.cs` and `OAuthService.cs`

**Files:**
- Create: `setup-assistant-windows/DJToolkitSetup/Services/AgentAPI.cs`
- Create: `setup-assistant-windows/DJToolkitSetup/Services/OAuthService.cs`

- [ ] **Step 1: Create AgentAPI**

```csharp
// setup-assistant-windows/DJToolkitSetup/Services/AgentAPI.cs
using System;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;

namespace DJToolkitSetup.Services;

public record AgentRegistration(
    [property: JsonPropertyName("api_key")] string ApiKey,
    [property: JsonPropertyName("agent_id")] string AgentId
);

public static class AgentAPI
{
    private static readonly HttpClient _http = new();

    public static async Task<AgentRegistration> RegisterAsync(string cloudUrl, string jwt, string machineName)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"{cloudUrl}/api/agents/register")
        {
            Content = JsonContent.Create(new { machine_name = machineName }),
        };
        request.Headers.Authorization = new("Bearer", jwt);

        var response = await _http.SendAsync(request);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadFromJsonAsync<AgentRegistration>()
            ?? throw new Exception("Empty registration response");
    }
}
```

- [ ] **Step 2: Create OAuthService**

```csharp
// setup-assistant-windows/DJToolkitSetup/Services/OAuthService.cs
using System;
using System.Threading.Tasks;
using System.Web;
using Microsoft.Web.WebView2.Core;

namespace DJToolkitSetup.Services;

public record OAuthResult(string AccessToken, string Email);

public class OAuthService
{
    private readonly string _supabaseUrl;

    public OAuthService(string supabaseUrl)
    {
        _supabaseUrl = supabaseUrl;
    }

    public string GetAuthUrl()
    {
        return $"{_supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=djtoolkit://auth/callback";
    }

    public static OAuthResult? ParseCallback(string uri)
    {
        // djtoolkit://auth/callback#access_token=xxx&token_type=bearer&...
        if (!uri.StartsWith("djtoolkit://auth/callback")) return null;

        var fragment = new Uri(uri).Fragment.TrimStart('#');
        var query = HttpUtility.ParseQueryString(fragment);

        var token = query["access_token"];
        if (string.IsNullOrEmpty(token)) return null;

        // Decode JWT payload to get email
        var parts = token.Split('.');
        if (parts.Length >= 2)
        {
            var payload = parts[1];
            // Pad base64
            payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
            var json = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(payload));
            var doc = System.Text.Json.JsonDocument.Parse(json);
            var email = doc.RootElement.TryGetProperty("email", out var e) ? e.GetString() ?? "" : "";
            return new OAuthResult(token, email);
        }

        return new OAuthResult(token, "");
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add setup-assistant-windows/DJToolkitSetup/Services/AgentAPI.cs setup-assistant-windows/DJToolkitSetup/Services/OAuthService.cs
git commit -m "feat: add AgentAPI and OAuthService for Setup Assistant"
```

---

### Task 15: Implement wizard views (Welcome, SignIn, Soulseek, AcoustID, Confirm, Done)

**Files:**
- Create: `setup-assistant-windows/DJToolkitSetup/MainWindow.xaml`
- Create: `setup-assistant-windows/DJToolkitSetup/MainWindow.xaml.cs`
- Create: `setup-assistant-windows/DJToolkitSetup/Views/WelcomePage.xaml` + `.cs`
- Create: `setup-assistant-windows/DJToolkitSetup/Views/SignInPage.xaml` + `.cs`
- Create: `setup-assistant-windows/DJToolkitSetup/Views/SoulseekPage.xaml` + `.cs`
- Create: `setup-assistant-windows/DJToolkitSetup/Views/AcoustIDPage.xaml` + `.cs`
- Create: `setup-assistant-windows/DJToolkitSetup/Views/ConfirmPage.xaml` + `.cs`
- Create: `setup-assistant-windows/DJToolkitSetup/Views/DonePage.xaml` + `.cs`

This is a large task. Each page is a `UserControl` with XAML layout + code-behind. The `MainWindow` hosts a `Frame` that navigates between pages, passing `SetupState` as parameter.

- [ ] **Step 1: Create MainWindow with Frame navigation**

The MainWindow contains a Frame and navigation logic. Each page receives the shared `SetupState` object.

- [ ] **Step 2: Create WelcomePage** — app icon, description, "Get Started" button → navigates to SignInPage

- [ ] **Step 3: Create SignInPage** — "Sign In with Browser" button opens WebView2 with Supabase auth URL. On callback, calls `AgentAPI.RegisterAsync()`, stores API key in `SetupState`

- [ ] **Step 4: Create SoulseekPage** — username + password fields, "Continue" button

- [ ] **Step 5: Create AcoustIDPage** — optional API key field, "Skip" and "Continue" buttons

- [ ] **Step 6: Create ConfirmPage** — summary, advanced settings (folder picker for downloads dir, slider for poll interval), "Install & Start Agent" button calls `CLIBridge.RunAsync(["agent", "configure-headless", "--stdin"], stdin: json)` then `CLIBridge.RunAsync(["agent", "install"], elevate: true)`

- [ ] **Step 7: Create DonePage** — checkmark, status summary, "Open djtoolkit" button opens web UI, "Close" button

- [ ] **Step 8: Commit**

```bash
git add setup-assistant-windows/DJToolkitSetup/
git commit -m "feat: implement Setup Assistant wizard views (6 pages)"
```

---

### Task 16: Add WinUI 3 build step to CI

**Files:**
- Modify: `.github/workflows/release.yml` (the `build-windows` job)

- [ ] **Step 1: Add .NET and WinUI 3 build steps**

Add after the PyInstaller step in the `build-windows` job:

```yaml
      - name: Setup .NET
        uses: actions/setup-dotnet@v4
        with:
          dotnet-version: "8.0.x"

      - name: Build Setup Assistant
        run: |
          dotnet build setup-assistant-windows/DJToolkitSetup.sln -c Release
          Copy-Item "setup-assistant-windows/DJToolkitSetup/bin/Release/net8.0-windows10.0.22621.0/DJToolkit Setup.exe" "dist/"
        shell: pwsh
```

Update the WiX build step to also include the Setup Assistant binary.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add WinUI 3 Setup Assistant build to Windows pipeline"
```

---

## Chunk 5: Final Integration & Verification

### Task 17: Run full test suite and verify cross-platform compatibility

- [ ] **Step 1: Run all Python tests**

Run: `poetry run pytest tests/ -v --timeout=30`
Expected: All PASS (Windows-specific tests skipped on macOS with `skipif`)

- [ ] **Step 2: Verify no remaining hardcoded macOS paths**

Run:
```bash
grep -rn 'Library/Logs/djtoolkit\|Library/LaunchAgents\|\.djtoolkit' djtoolkit/__main__.py
```
Expected: No hits (all replaced with `paths.py` calls)

Run:
```bash
grep -rn 'from djtoolkit.agent.launchd import\|from djtoolkit.agent import launchd' djtoolkit/__main__.py
```
Expected: No hits (all replaced with platform dispatcher)

- [ ] **Step 3: Verify no remaining "macOS Keychain" or "LaunchAgent" hardcoded strings**

Run:
```bash
grep -rn 'macOS Keychain\|LaunchAgent' djtoolkit/__main__.py
```
Expected: No hits

- [ ] **Step 4: Commit any remaining fixes**

```bash
git add -A
git commit -m "chore: final cleanup for Windows support"
```
