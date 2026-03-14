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
| `install(cfg)` | Register the service/agent to start at boot |
| `uninstall(cfg)` | Remove the service/agent registration |
| `start(cfg)` | Start the service/agent now |
| `stop(cfg)` | Stop the service/agent |
| `status(cfg)` | Return current status (running/stopped/not installed) |

The existing `__main__.py` agent commands change from importing `launchd` directly to using `get_service_manager()`, then calling `mgr.install(cfg)`, etc.

`launchd.py` keeps its current implementation unchanged — it already conforms to this interface.

---

## Windows Service Implementation

`agent/windows_service.py` uses `pywin32` to register and manage an NT service.

### Service Class

A `win32serviceutil.ServiceFramework` subclass that wraps the existing `daemon.py` event loop:

- `SvcDoRun()`: creates an asyncio event loop, runs `daemon.run_loop(cfg)`
- `SvcStop()`: sets a threading event that the daemon checks, triggering graceful shutdown (replaces the Unix `SIGTERM` handler)

### Signal Handling

`daemon.py` gets a platform branch for shutdown:

- **Unix (existing):** `loop.add_signal_handler(SIGTERM/SIGINT, handler)`
- **Windows:** accepts a `shutdown_event: threading.Event` parameter. The daemon polls this event alongside its normal work loop. When the service control manager calls `SvcStop()`, it sets the event, and the daemon exits cleanly.

### Service Configuration

| Property | Value |
|---|---|
| Service name | `DJToolkitAgent` |
| Display name | `djtoolkit Agent` |
| Start type | Automatic (starts at boot) |
| Recovery | Restart on first and second failure (60s delay) |
| Run as | Current user (needs network + file access) |

### Interface Functions

- `install(cfg)` — calls `win32serviceutil.InstallService()`, sets recovery options via `ChangeServiceConfig2`
- `uninstall(cfg)` — stops if running, then `RemoveService()`
- `start(cfg)` — `win32serviceutil.StartService()`
- `stop(cfg)` — `win32serviceutil.StopService()`
- `status(cfg)` — queries `QueryServiceStatus()`, returns running/stopped/not installed

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

Uses `WebView2` (ships with Windows 11) instead of `ASWebAuthenticationSession`. Same redirect to `djtoolkit://auth/callback`. The app registers the `djtoolkit://` protocol via the MSI installer (registry key under `HKCU\Software\Classes\djtoolkit`).

### CLIBridge

C# `Process` wrapper, same pattern as the Swift `CLIBridge`:

```csharp
// Step 5: all credentials piped via stdin
CLIBridge.Run(["agent", "configure-headless", "--stdin"], stdin: credentialsJson);
CLIBridge.Run(["agent", "install"]);
```

### Binary Resolution Order

1. Check `PATH` for `djtoolkit.exe`
2. Check `%ProgramFiles%\djtoolkit\djtoolkit.exe` (MSI install location)
3. If bundled in MSI: use binary from same install directory

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
│   ├── Package.appxmanifest            # Protocol registration
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
| `packaging/windows/djtoolkit.spec` | PyInstaller spec for Windows (`fpcalc.exe` path, `keyring.backends.Windows` backend) |
| `packaging/windows/djtoolkit.wxs` | WiX installer definition |
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
| Service install requires elevation | MSI runs elevated; `agent install` via CLIBridge may need elevation — if denied, show instructions to run as administrator |

---

## Security Considerations

- **JWT lifetime**: Short-lived (default 1 hour). Used immediately during setup, not a concern.
- **API key display**: Never shown in the wizard. Goes straight from API response to Credential Manager.
- **Credential passing**: `configure-headless` reads all credentials from stdin as JSON, avoiding `ps`/Process Explorer visibility of secrets.
- **Custom URL scheme hijacking**: Another app could register `djtoolkit://`. Mitigation: JWT integrity validated server-side during agent registration.

---

## Scope

### In scope

- Platform abstraction layer (`agent/platform.py`)
- Windows Service implementation (`agent/windows_service.py`)
- `daemon.py` signal handling for Windows (threading event)
- `config.py` platform-aware path resolution (`%APPDATA%`, `%USERPROFILE%`)
- `pywin32` Windows-only dependency
- WinUI 3 Setup Assistant with 6-step wizard
- OAuth via WebView2
- CLIBridge (C# Process wrapper)
- PyInstaller spec for Windows
- WiX MSI installer
- `release.yml` Windows build job
- `djtoolkit://` protocol registration

### Out of scope

- essentia-tensorflow on Windows (not available, already optional)
- Linux support (follows same pattern later)
- Code signing / Microsoft Store distribution (future)
- Automatic updates for the Setup Assistant
- In-app agent status monitoring (use `djtoolkit agent status` or web UI)
- Changing credentials after initial setup (use `djtoolkit agent configure` in terminal)
