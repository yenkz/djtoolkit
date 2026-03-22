# Tray App — Agent Management (macOS + Windows)

**Date**: 2026-03-22
**Status**: Approved (v2 — expanded scope: auto-update, reconfigure, uninstall, version check)

## Problem

After the initial setup wizard completes, macOS users have no GUI to manage the djtoolkit agent. Starting, stopping, and monitoring the service requires the CLI (`djtoolkit agent start/stop/status`), which is unfriendly for non-technical users.

## Solution

Two deliverables:

1. **macOS**: Extend the existing SwiftUI Setup Assistant (`DJToolkit Setup.app`) with a **tray mode** — a menu bar icon that provides service control, status monitoring, and quick access to common actions.
2. **Windows**: Extend the existing WinUI 3 tray app with new features (auto-update, reconfigure, uninstall) to reach feature parity.

Both platforms share the same feature set. macOS sections describe the primary architecture; Windows-specific differences are called out inline.

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
● Running                         ← status line (green/—/yellow dot)
──────────────────────────────────
Start Agent                       ← disabled when running or not installed
Stop Agent                        ← disabled when stopped or not installed
──────────────────────────────────
✓ Run at Startup                  ← checkbox toggle (Login Item + LaunchAgent)
──────────────────────────────────
Open Downloads Folder             ← reads downloads_dir from config.toml
Open Logs                         ← opens agent.log in default editor
Recent Activity...                ← opens popover (macOS) / window (Windows)
──────────────────────────────────
Reconfigure Agent...              ← lightweight config editor window
Open Web Dashboard                ← opens browser to app.djtoolkit.net
Re-run Setup...                   ← launches self without --tray (full wizard)
──────────────────────────────────
Check for Updates                 ← or "Update Available (vX.Y.Z)" when update found
──────────────────────────────────
Uninstall Agent...                ← confirmation dialog with cleanup level choice
Quit                              ← exits tray app only, agent keeps running
```

When agent is **not installed**, status line shows "Not Installed — run Setup to configure" and Start/Stop items are disabled.

### Menu actions

| Action | Implementation |
|--------|---------------|
| Start Agent | `Process` → `launchctl load ~/Library/LaunchAgents/com.djtoolkit.agent.plist`. Note: `load` registers AND starts (if `RunAtLoad` is true). Matches Python CLI behavior in `launchd.py`. Confirmed via `AgentMonitor` polling. |
| Stop Agent | `Process` → `launchctl unload ~/Library/LaunchAgents/com.djtoolkit.agent.plist`. Note: `unload` stops AND deregisters. If "Run at Startup" is ON, the LaunchAgent will be re-loaded on next login. Matches Python CLI behavior. |
| Run at Startup | `LoginItemManager` wraps `SMAppService.mainApp.register()` / `unregister()`. Also loads/unloads LaunchAgent to couple tray + agent lifecycle. **Partial failure**: If `SMAppService` succeeds but `launchctl` fails, roll back the `SMAppService` change and show alert. If `launchctl` succeeds but `SMAppService` fails, unload the LaunchAgent and show alert. |
| Open Downloads Folder | `ConfigReader` parses `~/.djtoolkit/config.toml` for `downloads_dir`. Falls back to `~/Music/djtoolkit/downloads` if config is missing. Opens via `NSWorkspace.shared.open()`. |
| Open Logs | Opens `~/Library/Logs/djtoolkit/agent.log` via `NSWorkspace`. If file doesn't exist, shows `NSAlert` "No log file found. Start the agent first." |
| Recent Activity | Opens `NSPopover` anchored to status bar button (next section). |
| Open Web Dashboard | `NSWorkspace.shared.open(URL("https://app.djtoolkit.net"))` |
| Re-run Setup | `NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: .init())` — launches the `.app` bundle (not the raw executable) without `--tray` args, so it opens in wizard mode. Tray app remains running; wizard opens as a separate process. |
| Reconfigure Agent | Opens a lightweight config editor window (see Reconfigure Agent section). |
| Check for Updates | Queries GitHub Releases API for latest version. If newer, downloads installer and launches it (see Auto-Update section). |
| Uninstall Agent | Shows confirmation dialog with cleanup level choice (see Uninstall Agent section). |
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

## First-Run Behavior

When the tray app launches with `--tray` and `~/.djtoolkit/config.toml` does not exist (macOS) or `%APPDATA%\djtoolkit\config.toml` does not exist (Windows), it means the agent has never been configured. In this case, the tray app automatically launches the setup wizard (same as "Re-run Setup") so the user can complete initial configuration. The tray icon still appears and stays running — the wizard is a separate process/window.

This ensures that installing the agent and enabling "Run at Startup" always leads to a configured agent on next login.

## Auto-Update

### Version source

The current app version is embedded at build time:
- **macOS**: `CFBundleShortVersionString` in `Info.plist` (set by Xcode build settings, derived from the git tag)
- **Windows**: Assembly version passed via WiX `$(var.Version)` at MSI build time. The C# app reads it via `Assembly.GetExecutingAssembly().GetName().Version`.

### Checking for updates

`UpdateChecker` queries the GitHub Releases API:

```
GET https://api.github.com/repos/yenkz/djtoolkit/releases/latest
Accept: application/vnd.github.v3+json
```

Response includes `tag_name` (e.g. `"v0.2.0"`) and `assets[]` with download URLs.

The check runs:
1. **On launch** — once, after a 5-second delay (avoids slowing startup)
2. **Every 24 hours** — via a repeating timer
3. **On demand** — when user clicks "Check for Updates"

Last check timestamp stored in:
- **macOS**: `UserDefaults.standard` key `"lastUpdateCheck"`
- **Windows**: `%APPDATA%\djtoolkit\update-check.json`

### Version comparison

Strip the `v` prefix from `tag_name`, parse as semantic version, compare with current version. If remote is newer → update available.

### Update available state

When an update is found:

1. **Menu item changes**: "Check for Updates" becomes **"Update Available (v0.2.0)"** with a bold/highlighted style
2. **Icon badge**: A small blue dot (6px) drawn at the **top-right** corner of the icon (status dot is at bottom-right). Both dots can coexist — e.g., green (running) at bottom-right + blue (update) at top-right. If no update, top-right is empty.
3. **Native notification**: Send a system notification:
   - **macOS**: `UNUserNotificationCenter` — title: "djtoolkit Update Available", body: "Version 0.2.0 is ready to install.", action: triggers update. **Note**: Requires calling `requestAuthorization(options: [.alert])` on first launch; if denied, notification is silently skipped (menu badge still works).
   - **Windows**: Toast notification via `AppNotificationManager` — same content, click action opens the update

Notification is sent once per discovered version (track `lastNotifiedVersion` alongside the check timestamp).

### Update flow

When the user triggers the update (via menu item or notification):

1. Show a progress indicator in the menu (macOS: update menu item title to "Downloading update..."; Windows: similar)
2. Download the platform-specific installer asset from the GitHub release:
   - **macOS**: the `.pkg` file (asset name matching `*arm64.pkg` or `*.pkg`)
   - **Windows**: the `.msi` file (asset name matching `*.msi`)
3. Save to a temp directory (`NSTemporaryDirectory()` / `Path.GetTempPath()`)
4. Launch the installer:
   - **macOS**: `Process` → `open <path>.pkg` (launches macOS Installer.app)
   - **Windows**: `Process.Start()` → `msiexec /i <path>.msi` (launches Windows Installer)
5. Quit the tray app (the installer will replace the binary; on next login or manual launch, the new version starts)

### Edge cases

- **No internet / API error**: Silently skip, retry on next 24h cycle. No error shown to user.
- **Rate limit** (GitHub API: 60 req/hr unauthenticated): Unlikely with 24h intervals. If 403 received, back off to next cycle.
- **Download fails**: Show alert "Update download failed. Try again later." and revert menu item to "Check for Updates".
- **No matching asset**: Show alert "No installer found for your platform in the latest release."

## Reconfigure Agent

A lightweight config editor window for changing common settings without running the full setup wizard.

### Presentation

- **macOS**: An `NSWindow` (or SwiftUI `Window` scene) — small form (~400×300px), non-modal
- **Windows**: A WinUI 3 `Window` — same layout and size

### Editable fields

| Field | Config key | Default |
|-------|-----------|---------|
| Downloads Directory | `downloads_dir` | `~/Music/djtoolkit/downloads` (macOS) / `%USERPROFILE%\Music\djtoolkit\downloads` (Windows) |
| Soulseek Username | `[soulseek] username` | (empty) |
| Soulseek Password | `[soulseek] password` | (empty, shown as secure field) |

Each field shows the current value read from `config.toml`. A "Browse..." button next to Downloads Directory opens a folder picker.

### Save behavior

On "Save":
1. Read the existing `config.toml` (preserve all other keys/sections)
2. Update only the changed values
3. Write back to `config.toml`
4. Show brief confirmation (auto-dismissing "Saved" label or toast)
5. If agent is running, show note: "Restart the agent for changes to take effect."

On "Cancel": close window, discard changes.

### Implementation

- **macOS**: `ReconfigureView.swift` (SwiftUI form) displayed in an `NSWindow`. TOML writing is done via **line-based string replacement** in `ConfigWriter.swift` — read the file as text, find the target key's line with regex, replace the value, write back. This avoids adding a TOML library dependency. Only 3 keys are editable, so regex is sufficient. If the key doesn't exist, append it to the appropriate section.
- **Windows**: `ReconfigureWindow.xaml` + `ReconfigureWindow.xaml.cs`. Uses `Tomlyn` (already a dependency) for both reading and writing — parse to `TomlTable`, modify values, serialize back.

## Uninstall Agent

### Trigger

Clicking "Uninstall Agent..." in the context menu.

### Confirmation dialog

An alert/dialog with the message:

> **Uninstall djtoolkit Agent?**
>
> This will stop the agent service, remove the CLI tool, and remove auto-start entries.

Two action buttons:
- **"Uninstall (keep settings)"** — removes agent but preserves `~/.djtoolkit` config and data
- **"Uninstall (remove everything)"** — full cleanup including config and data
- **"Cancel"** — dismiss

### Uninstall actions

#### Common to both cleanup levels

1. Stop the agent service:
   - **macOS**: `launchctl unload ~/Library/LaunchAgents/com.djtoolkit.agent.plist`
   - **Windows**: `djtoolkit agent stop` via CLIBridge
2. Remove LaunchAgent / Windows service registration:
   - **macOS**: Delete `~/Library/LaunchAgents/com.djtoolkit.agent.plist`
   - **Windows**: `sc delete DJToolkitAgent` (requires elevation)
3. Remove CLI binary:
   - **macOS**: Use `CLIBridge.findBinary()` to locate the binary (could be `/usr/local/bin/djtoolkit` on Intel or `/opt/homebrew/bin/djtoolkit` on Apple Silicon). If under a Homebrew prefix (`/opt/homebrew/` or `/usr/local/Cellar/`), show dialog: "djtoolkit was installed via Homebrew. Run `brew uninstall djtoolkit` to remove it." and skip binary deletion. Otherwise, delete with `osascript` admin prompt.
   - **Windows**: Delete the installed `djtoolkit.exe` from Program Files
4. Remove login item / startup entry:
   - **macOS**: `SMAppService.mainApp.unregister()`
   - **Windows**: Remove `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\DJToolkit Agent`
5. Remove log files:
   - **macOS**: `~/Library/Logs/djtoolkit/`
   - **Windows**: `%APPDATA%\djtoolkit\logs\`

#### Additional for "remove everything"

6. Delete config and data directory:
   - **macOS**: `~/.djtoolkit/`
   - **Windows**: `%APPDATA%\djtoolkit\`

#### Final steps

7. Show completion dialog: "djtoolkit has been uninstalled." with "OK" button
8. Clean up PID file (macOS) / release mutex (Windows)
9. Quit the tray app

### Edge cases

- **Permission denied** (e.g., CLI binary owned by root on macOS): Show `NSAlert` / MessageBox explaining manual removal needed, with the path.
- **Homebrew-installed CLI** (macOS): Detect by checking if binary path is under `/opt/homebrew/` or `/usr/local/Cellar/`. Show dialog suggesting `brew uninstall djtoolkit` instead of deleting directly (which would leave Homebrew's database inconsistent).
- **Agent not running**: Skip step 1, proceed with removal.
- **Partial failure**: Complete as many steps as possible, report any that failed.

## Periodic Version Check

Covered in the Auto-Update section above. Summary:

- **Interval**: Every 24 hours + on launch (5s delay) + on-demand via menu
- **Storage**: Last check time + last notified version persisted locally
- **Notification**: Native OS notification (once per new version discovered)
- **Badge**: Icon indicator when update is available
- **No user-facing errors**: Silent failure on network issues

## Files Changed

### Modified

| File | Change |
|------|--------|
| `setup-assistant/DJToolkitSetupApp.swift` | Dual-mode launch: parse `--tray`, set `.accessory` activation policy (runtime Dock hiding — no `LSUIElement` in Info.plist, which would break wizard mode), create `NSStatusItem` via `MenuBarManager`, single-instance PID guard, **first-run detection** (if `~/.djtoolkit/config.toml` missing → auto-launch wizard) |
| `setup-assistant/DJToolkitSetup.xcodeproj` | Add new Swift files to build target, add `MenuBarIcon` to asset catalog |

### New (macOS)

| File | Purpose |
|------|---------|
| `setup-assistant/DJToolkitSetup/MenuBar/MenuBarManager.swift` | Creates `NSStatusItem`, builds `NSMenu`, handles click events, status dot compositing on template icon |
| `setup-assistant/DJToolkitSetup/MenuBar/AgentMonitor.swift` | 10s timer polling `launchctl list com.djtoolkit.agent`, fires status-changed callback, three states (Running/Stopped/NotInstalled) |
| `setup-assistant/DJToolkitSetup/MenuBar/ConfigReader.swift` | Reads `~/.djtoolkit/config.toml` via Foundation string parsing, exposes `downloadsDir` with fallback to default |
| `setup-assistant/DJToolkitSetup/MenuBar/ConfigWriter.swift` | Read-modify-write of `config.toml` for reconfigure editor — preserves existing keys |
| `setup-assistant/DJToolkitSetup/MenuBar/StatusReader.swift` | Reads `~/.djtoolkit/agent-status.json`, decodes `recent_jobs` array, returns structured activity list |
| `setup-assistant/DJToolkitSetup/MenuBar/LoginItemManager.swift` | Wraps `SMAppService.mainApp` register/unregister, exposes `isEnabled` computed property |
| `setup-assistant/DJToolkitSetup/MenuBar/UpdateChecker.swift` | GitHub Releases API polling (24h + on-demand), version comparison, asset download, installer launch |
| `setup-assistant/DJToolkitSetup/MenuBar/Uninstaller.swift` | Agent removal logic — stop service, remove plist, CLI binary, login item, optionally config dir |
| `setup-assistant/DJToolkitSetup/Views/ActivityPopoverView.swift` | SwiftUI view for recent activity list inside `NSPopover`, anchored to status bar button |
| `setup-assistant/DJToolkitSetup/Views/ReconfigureView.swift` | SwiftUI form for lightweight config editing (downloads dir, Soulseek creds) |
| `setup-assistant/DJToolkitSetup/Assets.xcassets/MenuBarIcon.imageset/` | 18×18 monochrome template icon (PDF vector or @1x/@2x PNGs) derived from app icon |

### New / Modified (Windows)

| File | Change |
|------|--------|
| `setup-assistant-windows/DJToolkitSetup/Tray/TrayIconManager.cs` | Add menu items: Reconfigure, Check for Updates, Uninstall |
| `setup-assistant-windows/DJToolkitSetup/Tray/UpdateChecker.cs` | NEW — GitHub Releases API polling, version comparison, MSI download + launch |
| `setup-assistant-windows/DJToolkitSetup/Tray/ConfigWriter.cs` | NEW — Read-modify-write of config.toml via Tomlyn for reconfigure editor |
| `setup-assistant-windows/DJToolkitSetup/Tray/Uninstaller.cs` | NEW — Stop service, delete service, remove CLI binary, registry cleanup, optionally remove %APPDATA%\djtoolkit |
| `setup-assistant-windows/DJToolkitSetup/Views/ReconfigureWindow.xaml` | NEW — WinUI 3 config editor form |
| `setup-assistant-windows/DJToolkitSetup/Views/ReconfigureWindow.xaml.cs` | NEW — Code-behind for reconfigure window |
| `setup-assistant-windows/DJToolkitSetup/App.xaml.cs` | Add first-run detection (no config.toml → launch wizard) |

### Not changed

- Python agent — no changes (already has `recent_jobs` in `agent-status.json`)
- Web UI — no changes
- CI workflows — existing `ci-agents.yml` builds both platforms; new files are picked up automatically

## Dependencies

### macOS

No new dependencies. Uses only:
- `ServiceManagement` framework (already available on macOS 13+) for `SMAppService`
- `AppKit` (`NSStatusItem`, `NSMenu`, `NSPopover`) — included with macOS SDK
- `SwiftUI` — already used by the setup wizard
- `Foundation` — for `Process`, `JSONDecoder`, `URLSession` (GitHub API), file I/O
- `UserNotifications` — for `UNUserNotificationCenter` (update notifications)

### Windows

No new NuGet packages. Uses existing:
- `Tomlyn` — already used by `ConfigReader`, now also used for config writing
- `H.NotifyIcon.WinUI` — already used for tray icon
- `System.ServiceProcess.ServiceController` — already used for service management
- `Microsoft.WindowsAppSDK` — `AppNotificationManager` for toast notifications

## Testing

### Happy path (both platforms)

- Launch tray app → icon appears in menu bar / system tray, no main window
- Click icon → context menu shows all items with correct state
- Start/Stop Agent → service loads/unloads, icon dot changes within 10s
- Toggle "Run at Startup" → verify in system settings
- Log off/on with startup enabled → tray icon reappears automatically
- "Recent Activity" → popover (macOS) / window (Windows) shows recent jobs
- "Open Downloads Folder" → file manager opens to correct path
- "Open Logs" → log file opens in default text editor
- "Re-run Setup" → wizard window opens
- "Quit" → tray icon disappears, agent keeps running
- Launch tray twice → second instance exits silently
- Launch setup wizard while tray is running → both work independently

### New features

- **First-run**: Launch `--tray` with no `config.toml` → wizard auto-launches, tray stays running
- **Reconfigure Agent**: Opens config editor → edit downloads dir, Soulseek creds → save writes to `config.toml`
- **Check for Updates**: Click → queries GitHub API → "Up to date" or downloads installer → launches `.pkg`/`.msi` → tray quits
- **Periodic update check**: After 24h, badge appears on icon + native notification sent (once per version)
- **Uninstall (keep settings)**: Stops agent, removes service/plist, CLI binary, login item → shows confirmation → quits
- **Uninstall (remove everything)**: Same as above + deletes `~/.djtoolkit` / `%APPDATA%\djtoolkit`

### Error cases

- Agent not installed → yellow dot, "Not Installed" status, Start/Stop disabled
- Config file missing → "Open Downloads Folder" opens default path, Reconfigure shows empty fields
- Log file missing → "Open Logs" shows alert, "Recent Activity" shows "No activity yet."
- `agent-status.json` missing → "Recent Activity" shows "No activity yet."
- No internet during update check → silent skip, retry next cycle
- GitHub API rate limited → silent skip, retry next cycle
- Update download fails → alert "Download failed. Try again later."
- Uninstall permission denied (macOS CLI binary owned by root) → alert with path for manual removal

## Future enhancements (not in scope)

- macOS notifications on state changes (agent stopped unexpectedly, download batch completed)
- Richer tooltip showing active job count from `agent-status.json`
- Drag-and-drop files onto menu bar icon to trigger import
- Delta updates (download only changed files instead of full installer)
