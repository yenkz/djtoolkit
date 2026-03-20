# Windows System Tray App for Agent Management

**Date**: 2026-03-20
**Status**: Approved

## Problem

After the initial setup wizard completes, Windows users have no GUI to manage the djtoolkit agent. Starting, stopping, and monitoring the service requires the CLI (`djtoolkit agent start/stop/status`), which is unfriendly for non-technical users.

## Solution

Extend the existing WinUI 3 Setup Assistant (`DJToolkit Setup.exe`) with a **tray mode** — a system tray icon that provides service control, status monitoring, and quick access to common actions.

## Architecture: Dual-Mode App

The existing `DJToolkit Setup.exe` gains a `--tray` command-line argument:

- **No args** → Setup wizard (current behavior, unchanged)
- **`--tray`** → Hidden window, system tray icon only

### Launch logic (`App.xaml.cs`)

1. Parse command-line args in `OnLaunched`
2. If `--tray`: skip `MainWindow` activation, create `TaskbarIcon` via `H.NotifyIcon.WinUI`, stay alive in background
3. If no args: show `MainWindow` with wizard pages as today

### Single instance guard

A named mutex (`Local\DJToolkitTray`) prevents duplicate tray instances. `Local\` scope is per-user session, which is correct since the tray app is per-user. If `--tray` is launched while already running, exit silently. The setup wizard (no args) can always launch alongside the tray — it's short-lived.

### Startup registration

- The MSI writes a `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` registry key using `[INSTALLFOLDER]`: `"DJToolkit Agent" = "[INSTALLFOLDER]DJToolkit Setup.exe" --tray`
- The `StartupManager` class reads/writes this same registry key at runtime using the app's actual executable path
- The "Run at Startup" toggle in the tray menu adds/removes this registry key
- Toggling OFF also stops the agent service; toggling ON starts it
- This couples the tray app and agent service lifecycle — simpler mental model for non-technical users

## Tray Icon

### States

Three `.ico` assets bundled in the project:
- **Green** (`tray-green.ico`): agent service is running
- **Gray** (`tray-gray.ico`): agent service is stopped
- **Yellow** (`tray-yellow.ico`): agent service is not installed (setup not completed)

### Status polling

`ServiceMonitor` checks the `DJToolkitAgent` Windows service status every 10 seconds via `System.ServiceProcess.ServiceController` (NuGet package). Handles three states:

- **Running**: green icon, tooltip "djtoolkit Agent — Running"
- **Stopped**: gray icon, tooltip "djtoolkit Agent — Stopped"
- **Not installed**: yellow icon, tooltip "djtoolkit Agent — Not Installed". Catches `InvalidOperationException` from `ServiceController` when the service doesn't exist.

Fires a status-changed event that updates the tray icon and context menu item states.

### Start/Stop confirmation

Start/Stop Agent actions fire the CLI command via UAC elevation. Since `CLIBridge.RunAsync()` with `elevate=true` uses `UseShellExecute=true` (cannot capture exit codes), the tray app does **not** check the CLI return code. Instead, it relies on `ServiceMonitor` polling to detect the state change within the next 10-second cycle and update the icon accordingly.

## Context Menu (right-click)

```
djtoolkit Agent
● Running                         ← status line (green/red/yellow dot)
──────────────────────────────────
Start Agent                       ← disabled when running or not installed
Stop Agent                        ← disabled when stopped or not installed
──────────────────────────────────
✓ Run at Startup                  ← checkbox toggle (registry + service)
──────────────────────────────────
Open Downloads Folder             ← reads downloads_dir from config.toml
Open Logs                         ← opens agent.log in default text editor
Recent Activity...                ← opens popup window
──────────────────────────────────
Open Web Dashboard                ← opens browser to app.djtoolkit.net
Re-run Setup...                   ← launches self without --tray
──────────────────────────────────
Exit                              ← exits tray app only, service keeps running
```

When service is **not installed**, status line shows "Not Installed — run Setup to configure" and Start/Stop items are disabled.

### Menu actions

| Action | Implementation |
|--------|---------------|
| Start Agent | `CLIBridge` → `djtoolkit agent start` with `elevate=true` (UAC prompt). Confirmed via `ServiceMonitor` polling. |
| Stop Agent | `CLIBridge` → `djtoolkit agent stop` with `elevate=true`. Confirmed via `ServiceMonitor` polling. |
| Run at Startup | `StartupManager` reads/writes `HKCU\...\Run` registry key; also starts/stops service |
| Open Downloads Folder | `ConfigReader` reads `downloads_dir` from `%APPDATA%\djtoolkit\config.toml` via `Tomlyn`. Falls back to `~/Music/djtoolkit/downloads` if config is missing. Opens in Explorer. |
| Open Logs | Opens `%APPDATA%\djtoolkit\logs\agent.log` via `Process.Start`. If file doesn't exist, shows message "No log file found. Start the agent first." |
| Recent Activity | Opens `ActivityWindow` popup. If status file doesn't exist, shows "No activity yet." |
| Open Web Dashboard | Opens `https://app.djtoolkit.net` in default browser |
| Re-run Setup | Launches `DJToolkit Setup.exe` (without `--tray`) via `Process.Start` |
| Exit | Disposes `TaskbarIcon`, exits process. Service continues running independently. |

### Edge case handling

- **Config file missing** (`config.toml` doesn't exist): "Open Downloads Folder" falls back to `~/Music/djtoolkit/downloads` (matches `default_downloads_dir()` in Python agent)
- **Log file missing**: "Open Logs" shows an info dialog instead of crashing. "Recent Activity" shows "No activity yet."
- **UAC cancelled**: User dismisses the elevation prompt — no action taken, `ServiceMonitor` polling keeps current state. No error shown.

## Recent Activity Popup

### Trigger

Clicking "Recent Activity..." in the context menu.

### Window

Small borderless WinUI 3 window (~350x400px), positioned at bottom-right of the primary display using `DisplayArea.Primary`. Closes when it loses focus (click elsewhere to dismiss).

### Content

A `ListView` showing the last 10 jobs. Each row displays:
- Status icon: checkmark (success), cross (failed), spinner (in-progress)
- Job description: `"Downloaded 'Blue Monday'"`
- Artist + relative timestamp: `"New Order - 2 min ago"`

### Data source

`StatusReader` reads `%APPDATA%\djtoolkit\agent-status.json` (written by `save_daemon_status()` in `djtoolkit/agent/state.py`). This file contains structured data: `state`, `active_jobs`, `batch` progress, and cumulative `totals`. For per-job details (track title, artist, status), reads JSON files from `%APPDATA%\djtoolkit\jobs/` directory.

This is more reliable than regex-based log parsing and provides richer data (track metadata, job type, timestamps).

No polling — reads once when the popup opens. Close and reopen to refresh.

### Prerequisite: Python daemon changes

Two small changes in `djtoolkit/agent/state.py`:

1. **Fix Windows path**: `STATUS_FILE` and `DEFAULT_JOBS_DIR` currently use `Path.home() / ".djtoolkit"` which resolves to `C:\Users\<user>\.djtoolkit` on Windows. Must be updated to use `paths.config_dir()` so the status file lands at `%APPDATA%\djtoolkit\agent-status.json` — matching where the tray app reads from.

2. **Add `recent_jobs`**: Update `save_daemon_status()` to include a `recent_jobs` list with the last 10 completed jobs (title, artist, job_type, status, completed_at). The daemon already writes this file, it just needs the new field.

## Files Changed

### Modified

| File | Change |
|------|--------|
| `setup-assistant-windows/DJToolkitSetup/DJToolkitSetup.csproj` | Add `H.NotifyIcon.WinUI`, `System.ServiceProcess.ServiceController`, `Tomlyn` NuGet packages |
| `setup-assistant-windows/DJToolkitSetup/App.xaml.cs` | Dual-mode launch: parse `--tray`, named mutex, create `TaskbarIcon` |
| `setup-assistant-windows/DJToolkitSetup/Services/CLIBridge.cs` | Add `StartAgent()`, `StopAgent()` convenience methods |
| `packaging/windows/djtoolkit.wxs` | Add `HKCU\...\Run` registry key using `[INSTALLFOLDER]` for tray auto-start |
| `djtoolkit/agent/state.py` | Add `recent_jobs` list to `save_daemon_status()` output |

### New

| File | Purpose |
|------|---------|
| `setup-assistant-windows/DJToolkitSetup/Tray/TrayIconManager.cs` | Creates `TaskbarIcon`, builds context menu, handles click events |
| `setup-assistant-windows/DJToolkitSetup/Tray/ServiceMonitor.cs` | 10s timer polling `ServiceController("DJToolkitAgent")`, handles running/stopped/not-installed states |
| `setup-assistant-windows/DJToolkitSetup/Tray/StartupManager.cs` | Reads/writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, couples start/stop with service |
| `setup-assistant-windows/DJToolkitSetup/Tray/ConfigReader.cs` | Reads `config.toml` via Tomlyn, exposes `DownloadsDir` with fallback to default |
| `setup-assistant-windows/DJToolkitSetup/Tray/StatusReader.cs` | Reads `agent-status.json` and per-job files, returns structured recent activity list |
| `setup-assistant-windows/DJToolkitSetup/Views/ActivityWindow.xaml` | Recent Activity popup — borderless window with `ListView` |
| `setup-assistant-windows/DJToolkitSetup/Views/ActivityWindow.xaml.cs` | Code-behind: position at bottom-right via `DisplayArea`, close on lost focus, populate from `StatusReader` |
| `setup-assistant-windows/DJToolkitSetup/Assets/tray-green.ico` | Tray icon asset (running) |
| `setup-assistant-windows/DJToolkitSetup/Assets/tray-gray.ico` | Tray icon asset (stopped) |
| `setup-assistant-windows/DJToolkitSetup/Assets/tray-yellow.ico` | Tray icon asset (not installed) |

### Not changed

- macOS code — no changes
- Web UI — no changes
- GitHub Actions release workflow — existing `msbuild` step builds the entire project; NuGet restore handles new packages automatically

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `H.NotifyIcon.WinUI` | latest stable | System tray icon + context menu for WinUI 3 |
| `System.ServiceProcess.ServiceController` | latest stable (NuGet) | Query/control Windows service status |
| `Tomlyn` | latest stable | Parse `config.toml` to read `downloads_dir` and other settings |

Note: Adding these packages to the self-contained WinUI 3 app will increase the output binary size. `H.NotifyIcon.WinUI` is ~50KB, `Tomlyn` is ~100KB, `ServiceController` is minimal. The WinUI 3 runtime (already bundled) dominates the size.

## Testing

### Happy path

- Launch `DJToolkit Setup.exe --tray` → tray icon appears, no window
- Right-click tray → context menu shows all items with correct state
- Start/Stop Agent → UAC prompt, service starts/stops, icon color changes within 10s
- Toggle "Run at Startup" → registry key added/removed, verify via `regedit`
- Log off/on with "Run at Startup" enabled → tray icon reappears automatically
- "Recent Activity" → popup shows near tray bottom-right, closes on click-away
- "Open Downloads Folder" → Explorer opens to correct path
- "Open Logs" → agent.log opens in Notepad
- "Re-run Setup" → wizard window opens
- "Exit" → tray icon disappears, service keeps running
- Launch `--tray` twice → second instance exits silently (mutex guard)
- Launch setup wizard while tray is running → both work independently

### Error cases

- Agent service not installed → yellow icon, "Not Installed" status, Start/Stop disabled
- Config file missing → "Open Downloads Folder" opens default `~/Music/djtoolkit/downloads`
- Log file missing → "Open Logs" shows info dialog, "Recent Activity" shows "No activity yet."
- UAC prompt cancelled → no action, app remains stable, icon unchanged
- `agent-status.json` missing → "Recent Activity" shows "No activity yet."

## Future enhancements (not in scope)

- Toast/balloon notifications on state changes (agent stopped unexpectedly, download batch completed)
- Richer tooltip showing active job count from `agent-status.json`
