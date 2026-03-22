# macOS Menu Bar App for Agent Management

**Date**: 2026-03-22
**Status**: Approved

## Problem

After the initial setup wizard completes, macOS users have no GUI to manage the djtoolkit agent. Starting, stopping, and monitoring the service requires the CLI (`djtoolkit agent start/stop/status`), which is unfriendly for non-technical users.

## Solution

Extend the existing SwiftUI Setup Assistant (`DJToolkit Setup.app`) with a **tray mode** — a menu bar icon that provides service control, status monitoring, and quick access to common actions. Mirrors the Windows tray app functionality using native macOS patterns.

## Architecture: Dual-Mode App

The existing `DJToolkit Setup.app` gains a `--tray` command-line argument:

- **No args** → Setup wizard (current behavior, unchanged)
- **`--tray`** → No window, menu bar icon only, stays alive in background

### Launch logic (`DJToolkitSetupApp.swift`)

1. Parse `CommandLine.arguments` for `--tray`
2. If `--tray`: set `NSApp.setActivationPolicy(.accessory)` (hides from Dock), create `NSStatusItem` via `MenuBarManager`, skip wizard window
3. If no args: show wizard window with pages as today

### Single instance guard

A PID file at `~/.djtoolkit/tray.pid` prevents duplicate tray instances. On launch with `--tray`:
1. Check if PID file exists
2. If exists, read the PID and call `kill(pid, 0)` (signal 0 — checks process existence without sending a real signal)
3. If process is alive, exit silently
4. If process is dead (stale PID file from crash), delete file and continue

On startup, write `ProcessInfo.processInfo.processIdentifier` to the PID file. On clean exit (`applicationWillTerminate`), delete the PID file.

The setup wizard (no args) can always launch alongside the tray — it's short-lived.

### Login Item registration

Two separate mechanisms are managed together under the "Run at Startup" toggle:

1. **Tray app login item**: `SMAppService.mainApp.register()` / `unregister()` (macOS 13+, minimum deployment target is macOS 14). This makes the tray app launch at login. macOS displays this in System Settings > General > Login Items.
2. **Agent daemon LaunchAgent**: `launchctl load` / `unload` on `~/Library/LaunchAgents/com.djtoolkit.agent.plist`. This makes the Python agent daemon start at login (via `RunAtLoad: true`).

When toggling ON: register login item AND load the LaunchAgent. When toggling OFF: unregister login item AND unload the LaunchAgent. This couples both lifecycles — simpler mental model for non-technical users (same approach as the Windows tray app).

> **Tech debt note:** `launchctl load`/`unload` are deprecated (since macOS 10.10). The modern equivalents are `launchctl bootstrap gui/<uid> <plist>` / `launchctl bootout gui/<uid>/com.djtoolkit.agent`. The existing Python code in `launchd.py` also uses the deprecated API. Both should be migrated in a follow-up, but the deprecated commands still work on macOS 14+.

## Menu Bar Icon

### Template icon

A monochrome 18×18px version of the djtoolkit logo, provided as a PDF vector (or @1x/@2x PNGs) in the asset catalog. Marked as "Template Image" so macOS auto-tints for light and dark mode.

Source artwork derived from `setup-assistant/icon/AppIcon.iconset/`.

### Status indicator

A small colored dot (6px) drawn programmatically at runtime on the bottom-right corner of the template icon. `MenuBarManager` loads the template `NSImage`, locks focus, draws a filled `NSBezierPath` circle in the appropriate color, and assigns the composited image to `statusItem.button.image`:

- **Green dot**: agent running
- **No dot (icon only)**: agent stopped
- **Yellow dot**: agent not installed (launchd plist missing)

This follows the macOS convention (Dropbox, Docker Desktop) where the icon stays monochrome and a subtle indicator shows state. One template image asset, status drawn at runtime — no separate icon files needed.

### Status polling

`AgentMonitor` checks launchd status every 10 seconds by shelling out to `launchctl list com.djtoolkit.agent`:

- **Running**: exit 0 + valid PID → green dot, tooltip "djtoolkit Agent — Running"
- **Stopped**: exit 0 + PID `-` → no dot, tooltip "djtoolkit Agent — Stopped"
- **Not installed**: non-zero exit → yellow dot, tooltip "djtoolkit Agent — Not Installed"

Fires a status-changed callback that updates the menu bar icon and menu item states.

## Context Menu (click)

```
djtoolkit Agent
● Running                         ← status line (green/red/yellow dot)
──────────────────────────────────
Start Agent                       ← disabled when running or not installed
Stop Agent                        ← disabled when stopped or not installed
──────────────────────────────────
✓ Run at Startup                  ← checkbox toggle (Login Item + LaunchAgent)
──────────────────────────────────
Open Downloads Folder             ← reads downloads_dir from config.toml
Open Logs                         ← opens agent.log in default editor
Recent Activity...                ← opens popover
──────────────────────────────────
Open Web Dashboard                ← opens browser to app.djtoolkit.net
Re-run Setup...                   ← launches self without --tray
──────────────────────────────────
Quit                              ← exits tray app only, agent keeps running
```

When agent is **not installed**, status line shows "Not Installed — run Setup to configure" and Start/Stop items are disabled.

### Menu actions

| Action | Implementation |
|--------|---------------|
| Start Agent | `Process` → `launchctl load ~/Library/LaunchAgents/com.djtoolkit.agent.plist`. Confirmed via `AgentMonitor` polling. |
| Stop Agent | `Process` → `launchctl unload ~/Library/LaunchAgents/com.djtoolkit.agent.plist`. Confirmed via `AgentMonitor` polling. |
| Run at Startup | `LoginItemManager` wraps `SMAppService.mainApp.register()` / `unregister()`. Also loads/unloads LaunchAgent to couple tray + agent lifecycle. |
| Open Downloads Folder | `ConfigReader` parses `~/.djtoolkit/config.toml` for `downloads_dir`. Falls back to `~/Music/djtoolkit/downloads` if config is missing. Opens via `NSWorkspace.shared.open()`. |
| Open Logs | Opens `~/Library/Logs/djtoolkit/agent.log` via `NSWorkspace`. If file doesn't exist, shows `NSAlert` "No log file found. Start the agent first." |
| Recent Activity | Opens `NSPopover` anchored to status bar button (next section). |
| Open Web Dashboard | `NSWorkspace.shared.open(URL("https://app.djtoolkit.net"))` |
| Re-run Setup | `Process` → launch `Bundle.main.executablePath` (resolves to the binary inside the `.app` bundle) without `--tray`. Tray app remains running; wizard opens as a separate process. |
| Quit | `NSApp.terminate(nil)`. Agent continues running independently via launchd. |

### Edge case handling

- **Config file missing or corrupt** (`config.toml` doesn't exist or TOML parsing fails): "Open Downloads Folder" falls back to `~/Music/djtoolkit/downloads` (matches `default_downloads_dir()` in Python agent)
- **Log file missing**: "Open Logs" shows an NSAlert info dialog instead of crashing. "Recent Activity" shows "No activity yet."
- **LaunchAgent plist missing**: Yellow dot, "Not Installed" status, Start/Stop disabled
- **`launchctl load`/`unload` fails** (non-zero exit, e.g. malformed plist): Show `NSAlert` with the stderr output so the user can report the issue. `AgentMonitor` polling keeps the current state until next successful check.

## Recent Activity Popover

### Trigger

Clicking "Recent Activity..." in the context menu.

### Presentation

An `NSPopover` anchored to the `NSStatusItem` button. This is the native macOS pattern for menu bar app detail views (Wi-Fi, Bluetooth, etc.). Closes when clicking outside (popover's default behavior).

### Content

A SwiftUI `List` (~320×380px) showing the last 10 jobs. Each row displays:
- Status icon: `checkmark.circle.fill` (green, success), `xmark.circle.fill` (red, failed), `ProgressView` (in-progress)
- Job description: `"Downloaded 'Blue Monday'"`
- Artist + relative timestamp: `"New Order — 2 min ago"`

### Data source

`StatusReader` reads `~/.djtoolkit/agent-status.json` (written by `save_daemon_status()` in `djtoolkit/agent/state.py`). The `recent_jobs` list is already present in the status file (added for the Windows tray app).

No polling — reads once when the popover opens. Close and reopen to refresh.

### Empty state

If `agent-status.json` doesn't exist or `recent_jobs` is empty, shows "No activity yet." centered in the popover.

## Files Changed

### Modified

| File | Change |
|------|--------|
| `setup-assistant/DJToolkitSetupApp.swift` | Dual-mode launch: parse `--tray`, set `.accessory` activation policy (runtime Dock hiding — no `LSUIElement` in Info.plist, which would break wizard mode), create `NSStatusItem` via `MenuBarManager`, single-instance PID guard |
| `setup-assistant/DJToolkitSetup.xcodeproj` | Add new Swift files to build target, add `MenuBarIcon` to asset catalog |

### New

| File | Purpose |
|------|---------|
| `setup-assistant/DJToolkitSetup/MenuBar/MenuBarManager.swift` | Creates `NSStatusItem`, builds `NSMenu`, handles click events, status dot compositing on template icon |
| `setup-assistant/DJToolkitSetup/MenuBar/AgentMonitor.swift` | 10s timer polling `launchctl list com.djtoolkit.agent`, fires status-changed callback, three states (Running/Stopped/NotInstalled) |
| `setup-assistant/DJToolkitSetup/MenuBar/ConfigReader.swift` | Reads `~/.djtoolkit/config.toml` via Foundation string parsing, exposes `downloadsDir` with fallback to default |
| `setup-assistant/DJToolkitSetup/MenuBar/StatusReader.swift` | Reads `~/.djtoolkit/agent-status.json`, decodes `recent_jobs` array, returns structured activity list |
| `setup-assistant/DJToolkitSetup/MenuBar/LoginItemManager.swift` | Wraps `SMAppService.mainApp` register/unregister, exposes `isEnabled` computed property |
| `setup-assistant/DJToolkitSetup/Views/ActivityPopover.swift` | SwiftUI view for recent activity list inside `NSPopover`, anchored to status bar button |
| `setup-assistant/DJToolkitSetup/Assets.xcassets/MenuBarIcon.imageset/` | 18×18 monochrome template icon (PDF vector or @1x/@2x PNGs) derived from app icon |

### Not changed

- Windows code — no changes
- Python agent — no changes (already has `recent_jobs` in `agent-status.json`)
- Web UI — no changes
- CI workflows — existing `ci-agents.yml` and `release-macos.yml` build the same `.xcodeproj`; new files are picked up automatically

## Dependencies

No new dependencies. Uses only:
- `ServiceManagement` framework (already available on macOS 13+) for `SMAppService`
- `AppKit` (`NSStatusItem`, `NSMenu`, `NSPopover`) — included with macOS SDK
- `SwiftUI` — already used by the setup wizard
- `Foundation` — for `Process`, `JSONDecoder`, file I/O

## Testing

### Happy path

- Launch `DJToolkit Setup.app --tray` → icon appears in menu bar, no Dock icon, no window
- Click menu bar icon → context menu shows all items with correct state
- Start/Stop Agent → launchd loads/unloads, icon dot changes within 10s
- Toggle "Run at Startup" → verify in System Settings > General > Login Items
- Log off/on with startup enabled → tray icon reappears automatically
- "Recent Activity" → popover shows near menu bar icon, closes on click-away
- "Open Downloads Folder" → Finder opens to correct path
- "Open Logs" → agent.log opens in default text editor
- "Re-run Setup" → wizard window opens
- "Quit" → menu bar icon disappears, agent keeps running
- Launch `--tray` twice → second instance exits silently
- Launch setup wizard while tray is running → both work independently

### Error cases

- Agent not installed → yellow dot, "Not Installed" status, Start/Stop disabled
- Config file missing → "Open Downloads Folder" opens default `~/Music/djtoolkit/downloads`
- Log file missing → "Open Logs" shows NSAlert info dialog, "Recent Activity" shows "No activity yet."
- `agent-status.json` missing → "Recent Activity" shows "No activity yet."

## Future enhancements (not in scope)

- macOS notifications on state changes (agent stopped unexpectedly, download batch completed)
- Richer tooltip showing active job count from `agent-status.json`
- Drag-and-drop files onto menu bar icon to trigger import
