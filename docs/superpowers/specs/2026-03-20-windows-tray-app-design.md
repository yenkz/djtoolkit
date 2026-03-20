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

A named mutex (`Global\DJToolkitTray`) prevents duplicate tray instances. If `--tray` is launched while already running, exit silently. The setup wizard (no args) can always launch alongside the tray — it's short-lived.

### Startup registration

- The MSI writes a `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` registry key: `"DJToolkit Agent" = "C:\Program Files\djtoolkit\DJToolkit Setup.exe" --tray`
- The "Run at Startup" toggle in the tray menu adds/removes this registry key
- Toggling OFF also stops the agent service; toggling ON starts it
- This couples the tray app and agent service lifecycle — simpler mental model for non-technical users

## Tray Icon

### States

Two `.ico` assets bundled in the project:
- **Green** (`tray-green.ico`): agent service is running
- **Gray** (`tray-gray.ico`): agent service is stopped

### Status polling

`ServiceMonitor` checks the `DJToolkitAgent` Windows service status every 10 seconds via `System.ServiceProcess.ServiceController` (.NET built-in). Fires a status-changed event that updates the tray icon.

## Context Menu (right-click)

```
djtoolkit Agent
● Running                         ← status line (green/red dot)
──────────────────────────────────
Start Agent                       ← disabled when running
Stop Agent                        ← disabled when stopped
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

### Menu actions

| Action | Implementation |
|--------|---------------|
| Start Agent | `CLIBridge` → `djtoolkit agent start` with `elevate=true` (UAC prompt) |
| Stop Agent | `CLIBridge` → `djtoolkit agent stop` with `elevate=true` |
| Run at Startup | `StartupManager` reads/writes `HKCU\...\Run` registry key; also starts/stops service |
| Open Downloads Folder | Reads `downloads_dir` from `%APPDATA%\djtoolkit\config.toml`, opens in Explorer |
| Open Logs | Opens `%APPDATA%\djtoolkit\logs\agent.log` via `Process.Start` (default text editor) |
| Recent Activity | Opens `ActivityWindow` popup |
| Open Web Dashboard | Opens `https://app.djtoolkit.net` in default browser |
| Re-run Setup | Launches `DJToolkit Setup.exe` (without `--tray`) via `Process.Start` |
| Exit | Disposes `TaskbarIcon`, exits process. Service continues running independently. |

## Recent Activity Popup

### Trigger

Clicking "Recent Activity..." in the context menu.

### Window

Small borderless WinUI 3 window (~350x400px), positioned near the tray icon (bottom-right of screen). Closes when it loses focus.

### Content

A `ListView` showing the last 10 jobs parsed from the agent log. Each row displays:
- Status icon: checkmark (success), cross (failed), spinner (in-progress)
- Job description: `"Downloaded 'Blue Monday'"`
- Artist + relative timestamp: `"New Order - 2 min ago"`

### Data source

`LogParser` reads the last N lines from `%APPDATA%\djtoolkit\logs\agent.log`. The daemon already logs structured lines like `[job:download] completed: "Blue Monday" by New Order`. The parser extracts job type, track info, status, and timestamp using regex.

No polling — reads once when the popup opens. Close and reopen to refresh.

## Files Changed

### Modified

| File | Change |
|------|--------|
| `setup-assistant-windows/DJToolkitSetup/DJToolkitSetup.csproj` | Add `H.NotifyIcon.WinUI` NuGet package, add `System.ServiceProcess.ServiceController` |
| `setup-assistant-windows/DJToolkitSetup/App.xaml.cs` | Dual-mode launch: parse `--tray`, named mutex, create `TaskbarIcon` |
| `setup-assistant-windows/DJToolkitSetup/Services/CLIBridge.cs` | Add `StartAgent()`, `StopAgent()` convenience methods |
| `packaging/windows/djtoolkit.wxs` | Add `HKCU\...\Run` registry key for tray auto-start |

### New

| File | Purpose |
|------|---------|
| `setup-assistant-windows/DJToolkitSetup/Tray/TrayIconManager.cs` | Creates `TaskbarIcon`, builds context menu, handles click events |
| `setup-assistant-windows/DJToolkitSetup/Tray/ServiceMonitor.cs` | 10s timer polling `ServiceController("DJToolkitAgent")`, fires status-changed events |
| `setup-assistant-windows/DJToolkitSetup/Tray/StartupManager.cs` | Reads/writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, couples start/stop with service |
| `setup-assistant-windows/DJToolkitSetup/Tray/LogParser.cs` | Reads last N lines from `agent.log`, extracts job entries via regex |
| `setup-assistant-windows/DJToolkitSetup/Views/ActivityWindow.xaml` | Recent Activity popup — borderless window with `ListView` |
| `setup-assistant-windows/DJToolkitSetup/Views/ActivityWindow.xaml.cs` | Code-behind: position near tray, close on lost focus, populate from `LogParser` |
| `setup-assistant-windows/DJToolkitSetup/Assets/tray-green.ico` | Tray icon asset (running) |
| `setup-assistant-windows/DJToolkitSetup/Assets/tray-gray.ico` | Tray icon asset (stopped) |

### Not changed

- Python CLI code — no modifications needed
- Agent daemon (`daemon.py`) — log format already works
- macOS code — no changes
- Web UI — no changes
- GitHub Actions release workflow — existing `msbuild` step builds the entire project; NuGet restore handles new packages automatically

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `H.NotifyIcon.WinUI` | latest stable | System tray icon + context menu for WinUI 3 |
| `System.ServiceProcess.ServiceController` | (built-in .NET) | Query Windows service status |

## Testing

Manual verification on Windows:
- Launch `DJToolkit Setup.exe --tray` → tray icon appears, no window
- Right-click tray → context menu shows all items
- Start/Stop Agent → UAC prompt, service starts/stops, icon color changes
- Toggle "Run at Startup" → registry key added/removed, verify via `regedit`
- Log off/on with "Run at Startup" enabled → tray icon reappears automatically
- "Recent Activity" → popup shows near tray, closes on click-away
- "Open Downloads Folder" → Explorer opens to correct path
- "Open Logs" → agent.log opens in Notepad
- "Re-run Setup" → wizard window opens
- "Exit" → tray icon disappears, service keeps running
- Launch `--tray` twice → second instance exits silently (mutex guard)
- Launch setup wizard while tray is running → both work independently
