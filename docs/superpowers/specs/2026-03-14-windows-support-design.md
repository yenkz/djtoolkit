# Windows 11 Support — Design Spec

## Context

djtoolkit is currently macOS-only (arm64 + Intel x86_64). The core CLI is already mostly cross-platform thanks to consistent `pathlib` usage, but the agent daemon (launchd), build pipeline (PyInstaller + DMG), and Setup Assistant (SwiftUI) are all macOS-specific. This spec covers full Windows 11 parity: CLI, agent background service, Setup Assistant wizard, MSI installer, and CI pipeline.

**Out of scope:** essentia-tensorflow (no Windows support, already optional and gracefully skipped). Linux support (can follow the same platform abstraction pattern later).

---

## Architecture

### Overview

Three main components:

1. **Platform abstraction layer** — `agent/platform.py` dispatches to `agent/launchd.py` (macOS) or `agent/windows_service.py` (Windows) based on `sys.platform`. CLI commands (`agent install/uninstall/start/stop/status`) stay identical across platforms.

2. **Windows Service** — A `pywin32`-based NT service (`DJToolkitAgentService`) that wraps the existing `daemon.py` event loop. Installs via `agent install`, runs as the current user, auto-starts at boot, restarts on crash.

3. **Windows Setup Assistant** — A WinUI 3 (C#/.NET) app mirroring the macOS SwiftUI wizard: OAuth via `WebView2`, collects credentials, calls `djtoolkit agent configure-headless` via `Process`, then `agent install`. Bundled into an MSI built with WiX.

### Component Diagram

```
┌──────────────────────────────────────────────┐
│        DJToolkit Setup (WinUI 3)             │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │ Welcome  │→ │ Sign In  │→ │ Soulseek   │ │
│  │  View    │  │  View    │  │  View      │ │
│  └──────────┘  └──────────┘  └────────────┘ │
│                     │              │         │
│                     ▼              ▼         │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │  Done    │← │ Confirm  │← │ AcoustID   │ │
│  │  View    │  │ +Advanced│  │  View      │ │
│  └──────────┘  └──────────┘  └────────────┘ │
│       │             │                        │
│       │             ▼                        │
│       │     ┌──────────────┐                 │
│       │     │ CLIBridge    │                 │
│       │     │ (Process)    │                 │
│       │     └──────┬───────┘                 │
└───────┼────────────┼─────────────────────────┘
        │            │
        │            ▼
        │    ┌──────────────┐     ┌────────────────────┐
        │    │ djtoolkit    │     │ Windows Credential  │
        │    │ CLI binary   │────▶│ Manager (keyring)   │
        │    └──────┬───────┘     └────────────────────┘
        │           │
        │           ▼
        │    ┌──────────────┐     ┌───────────────┐
        │    │ Windows      │     │ %APPDATA%\     │
        │    │ Service (SC) │     │ djtoolkit\     │
        │    └──────────────┘     │ config.toml    │
        │                         └───────────────┘
        ▼
  WebView2 → Supabase Auth → JWT callback
        │
        ▼
  POST /api/agents/register (with JWT)
        │
        ▼
  Returns djt_xxx API key (one-time)
```

### Config/State Paths

| Purpose | macOS | Windows |
|---|---|---|
| Config file | `~/.djtoolkit/config.toml` | `%APPDATA%\djtoolkit\config.toml` |
| Logs | `~/Library/Logs/djtoolkit/` | `%APPDATA%\djtoolkit\logs\` |
| Default downloads | `~/Music/djtoolkit/downloads` | `%USERPROFILE%\Music\djtoolkit\downloads` |
| Credentials | macOS Keychain | Windows Credential Manager |

The `config.py` module detects the platform and resolves the appropriate directory.

---

## Platform Abstraction Layer

A new `agent/platform.py` module acts as the dispatcher. The CLI never imports `launchd.py` or `windows_service.py` directly.

```python
# agent/platform.py
import sys

def get_service_manager():
    if sys.platform == "darwin":
        from djtoolkit.agent import launchd
        return launchd
    elif sys.platform == "win32":
        from djtoolkit.agent import windows_service
        return windows_service
    else:
        raise RuntimeError(f"Unsupported platform: {sys.platform}")
```

Both `launchd.py` and `windows_service.py` expose the same interface:

| Function | Description |
|---|---|
| `install() -> Path \| None` | Register the service/agent to start at boot. Returns the config path (plist on macOS, `None` on Windows) |
| `uninstall()` | Remove the service/agent registration |
| `start()` | Start the service/agent now |
| `stop()` | Stop the service/agent |
| `is_installed()` | Return whether the service/agent is registered |
| `is_running()` | Return whether the service/agent is currently running |

This matches the existing `launchd.py` signatures (no `cfg` parameter — each module resolves its own paths internally). `launchd.py` already conforms to this interface unchanged.

### CLI Commands to Update

All agent commands in `__main__.py` currently import from `launchd` directly. These must change to use `get_service_manager()`:

- `agent_install` — `launchd.install()`. Also prints macOS-specific output (`"Plist: {path}"`); must use platform-aware messaging (e.g. "Service registered" on Windows)
- `agent_uninstall` — `launchd.uninstall()`. Also prints "Remove credentials from Keychain?" — "Keychain" must become platform-aware ("credential store")
- `agent_start` — `launchd.start()`
- `agent_stop` — `launchd.stop()`
- `agent_status` — `launchd.is_installed()` / `launchd.is_running()`. Prints "LaunchAgent" — must use generic "service" terminology
- `agent_configure` — hardcodes `Path.home() / ".djtoolkit"` and prints "Credentials stored in macOS Keychain" — both need platform-aware equivalents
- `agent_configure_headless` — hardcodes `Path.home() / ".djtoolkit"` and defaults `downloads_dir` to `~/Music/djtoolkit/downloads` — must use `paths.config_dir()` and `paths.default_downloads_dir()`
- `agent_logs` — hardcodes `~/Library/Logs/djtoolkit`; needs platform-aware log path (see below)
- `agent_run` — hardcodes `~/Library/Logs/djtoolkit` for file logging; needs platform-aware log path
- `setup_wizard` — currently rejects non-Darwin; must also support Windows, launching `DJToolkit Setup.exe` from `%ProgramFiles%\djtoolkit\`

### Platform-Aware Paths

Several shared code paths hardcode macOS-specific directories. These must use a platform helper:

```python
# agent/paths.py (new)
import sys
from pathlib import Path

def config_dir() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", "~")) / "djtoolkit"
    return Path.home() / ".djtoolkit"

def log_dir() -> Path:
    if sys.platform == "win32":
        return config_dir() / "logs"
    return Path.home() / "Library" / "Logs" / "djtoolkit"

def default_downloads_dir() -> Path:
    return Path.home() / "Music" / "djtoolkit" / "downloads"
```

Affected code:
- `__main__.py`: `agent_run`, `agent_logs`, `agent_configure`, `agent_configure_headless` — all hardcode `Path.home() / ".djtoolkit"`
- `config.py`: default path values
- `launchd.py`: `LOG_DIR` (stays macOS-specific, that's fine — it's the macOS module)

### `agent logs` on Windows

The `agent_logs` command runs `tail -f` which does not exist on Windows. On Windows, use Python's built-in file tailing (seek to end, poll for new lines) or `Get-Content -Wait` via PowerShell. The simplest cross-platform approach: implement a Python `_tail_follow()` helper used on all platforms, replacing the `tail -f` subprocess call.

---

## Windows Service Implementation

`agent/windows_service.py` uses `pywin32` to register and manage an NT service.

### Service Class

A `win32serviceutil.ServiceFramework` subclass that wraps the existing `daemon.py` event loop:

- `SvcDoRun()`: creates an asyncio event loop, runs `daemon.run_daemon(cfg)`. Stores a reference to the loop for cross-thread shutdown.
- `SvcStop()`: calls `loop.call_soon_threadsafe(shutdown_event.set)` to trigger graceful shutdown from the service control thread

### Signal Handling

`daemon.py` already uses an `asyncio.Event` (`shutdown_event`) for loop control, with Unix signal handlers calling `shutdown_event.set()`. The platform branch:

- **Unix (existing):** `loop.add_signal_handler(SIGTERM/SIGINT, handler)` calls `shutdown_event.set()`
- **Windows (as service):** `loop.add_signal_handler` is not available on Windows, and `SIGTERM` does not exist. The Windows Service's `SvcStop()` calls `loop.call_soon_threadsafe(shutdown_event.set)` to safely set the asyncio event from the service control thread. No `threading.Event` needed — the existing `asyncio.Event` is reused, just triggered from a different thread via the thread-safe trampoline. Signal handlers are skipped entirely.
- **Windows (as `agent run` in terminal):** `SIGINT` (Ctrl+C) is handled via a `try/except KeyboardInterrupt` wrapper around the event loop, which calls `shutdown_event.set()` on catch.

The `run_daemon()` function needs a small refactor: extract the signal handler setup into a platform-conditional block (`sys.platform != "win32"`), and accept an optional `shutdown_callback` parameter. On Windows, the service passes a callable that the daemon stores so `SvcStop()` can trigger shutdown via `loop.call_soon_threadsafe`.

### Service Configuration

| Property | Value |
|---|---|
| Service name | `DJToolkitAgent` |
| Display name | `djtoolkit Agent` |
| Start type | Automatic (starts at boot) |
| Recovery | Restart on all failures (60s delay) |
| Run as | Current user (needs network + file access) |

**Elevation:** Installing an NT service requires Administrator privileges. `djtoolkit agent install` on Windows must be run elevated. The Setup Assistant's CLIBridge launches the install step with `ProcessStartInfo.Verb = "runas"` to trigger the UAC elevation prompt. This differs from macOS where `launchctl load` works without elevation for user-scoped LaunchAgents.

### Interface Functions

- `install()` — calls `win32serviceutil.InstallService()`, sets recovery options via `ChangeServiceConfig2`
- `uninstall()` — stops if running, then `RemoveService()`
- `start()` — `win32serviceutil.StartService()`
- `stop()` — `win32serviceutil.StopService()`
- `is_installed()` — queries service control manager, returns bool
- `is_running()` — queries `QueryServiceStatus()`, returns bool

### Dependency

`pywin32` added as a Windows-only dependency in `pyproject.toml`:

```toml
[tool.poetry.dependencies]
pywin32 = {version = ">=306", markers = "sys_platform == 'win32'"}
```

---

## Windows Setup Assistant (WinUI 3)

A C#/.NET WinUI 3 app mirroring the macOS SwiftUI wizard. Same 6 steps, same `CLIBridge` pattern.

### Wizard Steps

Identical to the macOS Setup Assistant:

1. **Welcome** — app icon + "Set up djtoolkit on this PC", "Get Started" button
2. **Sign In** — "Sign In with Browser" opens `WebView2` to Supabase Auth. On JWT callback, calls `POST /api/agents/register`, stores API key in memory. Shows "Signed in as {email}"
3. **Soulseek Credentials** — username + password fields
4. **AcoustID** — optional API key, skip button
5. **Confirm & Install** — summary card, advanced settings (downloads dir via folder picker, poll interval slider). "Install & Start Agent" button triggers `CLIBridge`
6. **Done** — checkmark, "djtoolkit is running", shows downloads path + log location, "Open djtoolkit" button opens web UI

### OAuth Flow

Uses `WebView2` (ships with Windows 11) instead of `ASWebAuthenticationSession`. Same redirect to `djtoolkit://auth/callback`. The `djtoolkit://` protocol is registered via the MSI installer (registry key under `HKCU\Software\Classes\djtoolkit`). The app itself does not handle protocol registration — the MSI owns that.

### CLIBridge

C# `Process` wrapper, same pattern as the Swift `CLIBridge`:

```csharp
// Step 5: all credentials piped via stdin
CLIBridge.Run(["agent", "configure-headless", "--stdin"], stdin: credentialsJson);
CLIBridge.Run(["agent", "install"]);
```

### Binary Resolution Order

1. Check `%ProgramFiles%\djtoolkit\djtoolkit.exe` (MSI install location — preferred, avoids PATH propagation delay after fresh install)
2. Check `PATH` for `djtoolkit.exe`
3. Fallback: check adjacent directory if running from a dev/build context

### New CLI Command: `agent configure-headless`

Same command as specified in the macOS Setup Assistant design. Reads a JSON blob from stdin, stores credentials in the system credential store (Keychain on macOS, Credential Manager on Windows), writes config file, exits with JSON status on stdout. This command is shared across both platforms.

### Project Structure

```
setup-assistant-windows/
├── DJToolkitSetup.sln
├── DJToolkitSetup/
│   ├── App.xaml / App.xaml.cs          # Entry point, protocol handler
│   ├── Views/
│   │   ├── WelcomePage.xaml
│   │   ├── SignInPage.xaml
│   │   ├── SoulseekPage.xaml
│   │   ├── AcoustIDPage.xaml
│   │   ├── ConfirmPage.xaml
│   │   └── DonePage.xaml
│   ├── Models/
│   │   └── SetupState.cs               # Observable state
│   ├── Services/
│   │   ├── CLIBridge.cs                # Process wrapper
│   │   ├── OAuthService.cs            # WebView2 auth flow
│   │   └── AgentAPI.cs                 # POST /agents/register via HttpClient
│   └── Assets/
└── DJToolkitSetup.Tests/
    └── CLIBridgeTests.cs
```

---

## MSI Installer (WiX)

The MSI installs three things: the CLI binary, the Setup Assistant app, and the `fpcalc.exe` binary. It also registers the `djtoolkit://` protocol scheme.

### Install Layout

```
%ProgramFiles%\djtoolkit\
├── djtoolkit.exe              # CLI binary (PyInstaller)
├── fpcalc.exe                 # Chromaprint fingerprinter
└── DJToolkit Setup.exe        # WinUI 3 wizard
```

### MSI Actions

1. Install files to `%ProgramFiles%\djtoolkit\`
2. Add `%ProgramFiles%\djtoolkit\` to the system `PATH`
3. Register `djtoolkit://` protocol scheme in `HKCU\Software\Classes\djtoolkit`
4. Launch the Setup Assistant after install (optional, user-dismissable)

The MSI does **not** install or start the Windows Service — that's the Setup Assistant's job (via `djtoolkit agent install`), same as macOS where the DMG doesn't install the LaunchAgent.

### WiX Project Structure

```
packaging/windows/
├── djtoolkit.wxs              # Main WiX source (components, features, UI)
├── build.ps1                  # PowerShell build script (PyInstaller + WiX)
└── assets/
    ├── banner.bmp             # Installer banner (493x58)
    ├── dialog.bmp             # Installer background (493x312)
    └── icon.ico               # App icon
```

### Uninstall Behavior

- Removes files from `%ProgramFiles%\djtoolkit\`
- Removes `PATH` entry
- Removes protocol registration
- Does **not** remove `%APPDATA%\djtoolkit\` (config/logs/credentials) — user data preserved
- Does **not** uninstall the Windows Service — user should run `djtoolkit agent uninstall` first. MSI shows a reminder dialog if the service is detected as installed.

---

## CI / Release Pipeline

A new `build-windows` job in `release.yml`, running alongside the existing macOS job.

### Job Structure

```yaml
build-windows:
  runs-on: windows-latest
  steps:
    # 1. Checkout + Python setup
    - uses: actions/checkout@v4
    - uses: actions/setup-python@v5
      with: { python-version: "3.12" }

    # 2. Build CLI binary via PyInstaller
    - run: |
        pip install poetry
        poetry install
        poetry run pyinstaller packaging/windows/djtoolkit.spec

    # 3. Download fpcalc.exe (Chromaprint Windows binary)
    - run: # Download from Chromaprint GitHub releases, extract to dist/

    # 4. Build Setup Assistant (WinUI 3)
    - uses: microsoft/setup-msbuild@v2
    - run: msbuild setup-assistant-windows/DJToolkitSetup.sln /p:Configuration=Release

    # 5. Build MSI via WiX
    - run: packaging/windows/build.ps1

    # 6. Upload MSI as release asset
    - uses: softprops/action-gh-release@v2
      with:
        files: dist/djtoolkit-*.msi
```

### New Files

| File | Purpose |
|---|---|
| `packaging/windows/djtoolkit.spec` | PyInstaller spec for Windows (`fpcalc.exe` path, `keyring.backends.Windows` backend, `pywin32` hidden imports: `win32serviceutil`, `win32service`, `win32event`, `servicemanager`) |
| `packaging/windows/djtoolkit.wxs` | WiX 4+ installer definition (uses `wix build` CLI, not legacy `candle`/`light`) |
| `packaging/windows/build.ps1` | Orchestrates PyInstaller + WiX build |

### Release Assets

After this change, each release produces:

- `djtoolkit-x.y.z-arm64.dmg` (macOS)
- `djtoolkit-x.y.z-arm64.tar.gz` (macOS Homebrew)
- `djtoolkit-x.y.z-windows.msi` (Windows)

---

## Error Handling

| Scenario | Handling |
|---|---|
| OAuth cancelled by user | Return to Sign In step, "Sign-in was cancelled" message |
| OAuth token expired | Show error, prompt to sign in again |
| Agent registration fails (network) | Show retry button with error message |
| CLI binary not found | "djtoolkit CLI not found" — should not happen with MSI install, but offer manual PATH instructions |
| `configure-headless` fails | Show error output from CLI, offer to retry or go back |
| `agent install` fails | Show error, offer to copy manual terminal commands |
| Credential Manager access denied | Prompt user to allow access |
| Already configured | Detect existing `%APPDATA%\djtoolkit\config.toml`, offer to reconfigure or skip |
| Service already running | Check via `QueryServiceStatus()`; if running, show status and offer to reconfigure or close wizard |
| Service install requires elevation | CLIBridge launches `agent install` with `Verb = "runas"` for UAC prompt; if denied, show instructions to run as administrator |
| No internet connectivity | Check connectivity before OAuth step; show "No internet connection" with retry button |

---

## Security Considerations

- **JWT lifetime**: Short-lived (default 1 hour). Used immediately during setup, not a concern.
- **API key display**: Never shown in the wizard. Goes straight from API response to Credential Manager.
- **Credential passing**: `configure-headless` reads all credentials from stdin as JSON, avoiding `ps`/Process Explorer visibility of secrets.
- **Custom URL scheme hijacking**: Another app could register `djtoolkit://`. Mitigation: JWT integrity validated server-side during agent registration.

---

## Known Limitations

- **Windows SmartScreen:** Unsigned executables trigger SmartScreen warnings that are more aggressive than macOS Gatekeeper. Users must click "More info" → "Run anyway" on first launch. This is acceptable for an early-stage tool with a technical audience. Code signing is out of scope for the initial release.
- **PATH propagation delay:** MSI adds the install directory to PATH, but this only takes effect for new processes. The Setup Assistant (launched as a post-install action) uses the direct `%ProgramFiles%\djtoolkit\djtoolkit.exe` path instead of relying on PATH resolution.
- **`fpcalc.exe` extension:** `shutil.which("fpcalc")` handles `.exe` resolution automatically on Windows. The `fpcalc_path` config key also works with `.exe` — no code changes needed.
- **WinUI 3 unpackaged mode:** The Setup Assistant uses the unpackaged WinUI 3 deployment model (no MSIX). Protocol registration is handled entirely by the MSI via registry keys, not by the app manifest. The MSI must bundle the Windows App SDK runtime redistributable (or install it as a prerequisite), since unpackaged WinUI 3 apps require it at runtime.
- **Windows Defender false positives:** PyInstaller-generated executables are frequently flagged by Windows Defender as suspicious (separate from SmartScreen). Code signing (out of scope for initial release) is the long-term fix.
- **pywin32 service packaging:** When running as an NT service from a PyInstaller-frozen executable, the service binary path registered with SCM should point to `djtoolkit.exe` with a `service` subcommand (e.g. `djtoolkit.exe agent service-entry`), avoiding the need to ship a separate `pythonservice.exe`.

---

## Scope

### In scope

- Platform abstraction layer (`agent/platform.py`, `agent/paths.py`)
- Windows Service implementation (`agent/windows_service.py`)
- `daemon.py` signal handling for Windows (`call_soon_threadsafe`)
- `config.py` platform-aware path resolution (`%APPDATA%`, `%USERPROFILE%`)
- `__main__.py` agent commands refactored to use `get_service_manager()`
- `agent logs` cross-platform tail implementation
- `setup_wizard` command updated for Windows
- `pywin32` Windows-only dependency
- WinUI 3 Setup Assistant (unpackaged) with 6-step wizard
- OAuth via WebView2
- CLIBridge (C# Process wrapper) with UAC elevation for service install
- PyInstaller spec for Windows (with `pywin32` hidden imports)
- WiX 4+ MSI installer
- `release.yml` Windows build job (`windows-latest`)
- `djtoolkit://` protocol registration via MSI registry keys

### Out of scope

- essentia-tensorflow on Windows (not available, already optional)
- Linux support (follows same pattern later)
- Code signing / Microsoft Store distribution (future)
- Automatic updates for the Setup Assistant
- In-app agent status monitoring (use `djtoolkit agent status` or web UI)
- Changing credentials after initial setup (use `djtoolkit agent configure` in terminal)
