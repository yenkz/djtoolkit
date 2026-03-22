# macOS Menu Bar App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add menu bar (tray) mode to the existing macOS Setup Assistant so users can manage the djtoolkit agent daemon without the CLI.

**Architecture:** Dual-mode SwiftUI app — `--tray` flag activates menu bar mode (NSStatusItem + NSMenu), no-args shows existing wizard. Six new Swift files in a `MenuBar/` group handle status polling, config reading, login item management, and a recent activity popover.

**Tech Stack:** Swift 5.9+, SwiftUI, AppKit (NSStatusItem, NSMenu, NSPopover), ServiceManagement (SMAppService), Foundation (Process, JSONDecoder)

**Spec:** `docs/superpowers/specs/2026-03-22-macos-tray-app-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `setup-assistant/DJToolkitSetup/MenuBar/AgentMonitor.swift` | 10s polling of `launchctl list com.djtoolkit.agent`, publishes `AgentStatus` enum |
| `setup-assistant/DJToolkitSetup/MenuBar/MenuBarManager.swift` | Creates NSStatusItem, builds NSMenu, handles all menu actions, composites status dot on icon |
| `setup-assistant/DJToolkitSetup/MenuBar/ConfigReader.swift` | Reads `~/.djtoolkit/config.toml`, exposes `downloadsDir` with fallback |
| `setup-assistant/DJToolkitSetup/MenuBar/StatusReader.swift` | Reads `~/.djtoolkit/agent-status.json`, decodes `recent_jobs` array |
| `setup-assistant/DJToolkitSetup/MenuBar/LoginItemManager.swift` | Wraps `SMAppService.mainApp` register/unregister |
| `setup-assistant/DJToolkitSetup/MenuBar/UpdateChecker.swift` | GitHub Releases API polling, version comparison, .pkg download + launch |
| `setup-assistant/DJToolkitSetup/MenuBar/NotificationManager.swift` | macOS native notifications via UNUserNotificationCenter |
| `setup-assistant/DJToolkitSetup/MenuBar/ConfigWriter.swift` | Read-modify-write of config.toml via regex for reconfigure editor |
| `setup-assistant/DJToolkitSetup/MenuBar/Uninstaller.swift` | Agent removal: stop service, remove plist, CLI binary, login item, config |
| `setup-assistant/DJToolkitSetup/Views/ActivityPopoverView.swift` | SwiftUI list of recent jobs inside NSPopover |
| `setup-assistant/DJToolkitSetup/Views/ReconfigureView.swift` | SwiftUI form for lightweight config editing |
| `setup-assistant/DJToolkitSetup/Assets.xcassets/MenuBarIcon.imageset/` | 18x18 monochrome template icon |

### Modified files

| File | Change |
|------|--------|
| `setup-assistant/DJToolkitSetup/DJToolkitSetupApp.swift` | Parse `--tray`, branch to menu bar mode or wizard |

---

### Task 1: AgentMonitor — launchd status polling

**Files:**
- Create: `setup-assistant/DJToolkitSetup/MenuBar/AgentMonitor.swift`

This is the foundation — everything else depends on knowing the agent's status.

- [ ] **Step 1: Create AgentMonitor.swift**

```swift
import Foundation
import Observation

enum AgentStatus {
    case running
    case stopped
    case notInstalled
}

@Observable
final class AgentMonitor {
    private(set) var status: AgentStatus = .notInstalled
    private var timer: Timer?

    private static let label = "com.djtoolkit.agent"
    private static let plistPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/LaunchAgents/com.djtoolkit.agent.plist")

    init() {
        checkStatus()
    }

    func startPolling() {
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.checkStatus()
        }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    func checkStatus() {
        guard FileManager.default.fileExists(atPath: Self.plistPath.path) else {
            status = .notInstalled
            return
        }

        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["list", Self.label]
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            status = .notInstalled
            return
        }

        if process.terminationStatus != 0 {
            status = .stopped
            return
        }

        // Parse output: launchctl list outputs PID, last exit status, label
        // If PID column is "-", the service is loaded but not running
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        if output.contains("\t-\t") || output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            status = .stopped
        } else {
            status = .running
        }
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `xcodebuild -project setup-assistant/DJToolkitSetup.xcodeproj -scheme DJToolkitSetup -configuration Debug build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -5`

Note: After creating the file, you must add it to the Xcode project's build sources. Use the `pbxproj` file or `xcodebuild` — the simplest approach is to add a wildcard source group in the project file. Alternatively, manually add each `.swift` file to the `PBXSourcesBuildPhase` in `project.pbxproj`.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/MenuBar/AgentMonitor.swift
git commit -m "feat(macos-tray): add AgentMonitor for launchd status polling"
```

---

### Task 2: ConfigReader — TOML config parsing

**Files:**
- Create: `setup-assistant/DJToolkitSetup/MenuBar/ConfigReader.swift`

Lightweight TOML reader — only needs to extract `downloads_dir` from `[agent]` section.

- [ ] **Step 1: Create ConfigReader.swift**

```swift
import Foundation

enum ConfigReader {
    private static let configDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".djtoolkit")
    private static let configPath = configDir.appendingPathComponent("config.toml")
    private static let defaultDownloadsDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Music/djtoolkit/downloads").path

    static let logFilePath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/djtoolkit/agent.log").path

    /// Read downloads_dir from config.toml. Falls back to ~/Music/djtoolkit/downloads.
    static var downloadsDir: String {
        guard let contents = try? String(contentsOf: configPath, encoding: .utf8) else {
            return defaultDownloadsDir
        }

        // Simple line-by-line TOML parsing — find downloads_dir = "..."
        for line in contents.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("downloads_dir") {
                if let eqIndex = trimmed.firstIndex(of: "=") {
                    var value = trimmed[trimmed.index(after: eqIndex)...]
                        .trimmingCharacters(in: .whitespaces)
                    // Strip quotes
                    if value.hasPrefix("\"") && value.hasSuffix("\"") {
                        value = String(value.dropFirst().dropLast())
                    }
                    // Expand ~
                    if value.hasPrefix("~") {
                        value = value.replacingOccurrences(
                            of: "~",
                            with: FileManager.default.homeDirectoryForCurrentUser.path,
                            range: value.startIndex..<value.index(after: value.startIndex)
                        )
                    }
                    return value.isEmpty ? defaultDownloadsDir : value
                }
            }
        }

        return defaultDownloadsDir
    }
}
```

- [ ] **Step 2: Verify it compiles**

Build the project as in Task 1 Step 2.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/MenuBar/ConfigReader.swift
git commit -m "feat(macos-tray): add ConfigReader for TOML config parsing"
```

---

### Task 3: StatusReader — recent activity from agent-status.json

**Files:**
- Create: `setup-assistant/DJToolkitSetup/MenuBar/StatusReader.swift`

Reads the `recent_jobs` array from `~/.djtoolkit/agent-status.json`.

- [ ] **Step 1: Create StatusReader.swift**

```swift
import Foundation

struct RecentJob: Identifiable {
    let id = UUID()
    let title: String
    let artist: String
    let jobType: String
    let status: String // "success", "failed", or "in_progress"
    let completedAt: Date

    var relativeTime: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: completedAt, relativeTo: Date())
    }
}

enum StatusReader {
    private static let statusPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".djtoolkit/agent-status.json")

    /// Read the last 10 recent jobs from agent-status.json. Returns empty array if unavailable.
    static func recentJobs() -> [RecentJob] {
        guard let data = try? Data(contentsOf: statusPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let jobs = json["recent_jobs"] as? [[String: Any]] else {
            return []
        }

        return jobs.suffix(10).compactMap { job in
            guard let title = job["title"] as? String,
                  let artist = job["artist"] as? String,
                  let jobType = job["job_type"] as? String,
                  let status = job["status"] as? String,
                  let timestamp = job["completed_at"] as? Double else {
                return nil
            }
            return RecentJob(
                title: title,
                artist: artist,
                jobType: jobType,
                status: status,
                completedAt: Date(timeIntervalSince1970: timestamp)
            )
        }
    }
}
```

- [ ] **Step 2: Verify it compiles**

Build the project as in Task 1 Step 2.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/MenuBar/StatusReader.swift
git commit -m "feat(macos-tray): add StatusReader for recent activity data"
```

---

### Task 4: LoginItemManager — SMAppService wrapper

**Files:**
- Create: `setup-assistant/DJToolkitSetup/MenuBar/LoginItemManager.swift`

Wraps `SMAppService.mainApp` for the "Run at Startup" toggle.

- [ ] **Step 1: Create LoginItemManager.swift**

```swift
import ServiceManagement

enum LoginItemManager {
    /// Whether the app is registered as a login item.
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    /// Register the app to launch at login.
    static func enable() throws {
        try SMAppService.mainApp.register()
    }

    /// Unregister the app from launching at login.
    static func disable() {
        // unregister can throw but we don't need to surface errors for disable
        try? SMAppService.mainApp.unregister()
    }
}
```

- [ ] **Step 2: Verify it compiles**

Build the project as in Task 1 Step 2.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/MenuBar/LoginItemManager.swift
git commit -m "feat(macos-tray): add LoginItemManager wrapping SMAppService"
```

---

### Task 5: ActivityPopoverView — recent activity UI

**Files:**
- Create: `setup-assistant/DJToolkitSetup/Views/ActivityPopoverView.swift`

SwiftUI view displayed inside an NSPopover, showing the last 10 jobs.

- [ ] **Step 1: Create ActivityPopoverView.swift**

```swift
import SwiftUI

struct ActivityPopoverView: View {
    let jobs: [RecentJob]

    var body: some View {
        VStack(spacing: 0) {
            Text("Recent Activity")
                .font(.headline)
                .padding(.top, 12)
                .padding(.bottom, 8)

            Divider()

            if jobs.isEmpty {
                Spacer()
                Text("No activity yet.")
                    .foregroundStyle(.secondary)
                    .font(.body)
                Spacer()
            } else {
                List(jobs) { job in
                    HStack(spacing: 10) {
                        // Status icon
                        if job.status == "in_progress" {
                            ProgressView()
                                .controlSize(.small)
                                .frame(width: 20, height: 20)
                        } else {
                            Image(systemName: job.status == "success"
                                  ? "checkmark.circle.fill"
                                  : "xmark.circle.fill")
                                .foregroundStyle(job.status == "success" ? .green : .red)
                                .font(.title3)
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            Text(jobDescription(job))
                                .font(.callout)
                                .lineLimit(1)
                            Text("\(job.artist) \u{2014} \(job.relativeTime)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .listStyle(.plain)
            }
        }
        .frame(width: 320, height: 380)
    }

    private func jobDescription(_ job: RecentJob) -> String {
        switch job.jobType {
        case "download": return "Downloaded '\(job.title)'"
        case "fingerprint": return "Fingerprinted '\(job.title)'"
        case "cover_art": return "Cover art for '\(job.title)'"
        case "metadata": return "Tagged '\(job.title)'"
        case "audio_analysis": return "Analyzed '\(job.title)'"
        default: return "\(job.jobType): '\(job.title)'"
        }
    }
}
```

- [ ] **Step 2: Verify it compiles**

Build the project as in Task 1 Step 2.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/Views/ActivityPopoverView.swift
git commit -m "feat(macos-tray): add ActivityPopoverView for recent jobs"
```

---

### Task 6: Menu bar icon asset

**Files:**
- Create: `setup-assistant/DJToolkitSetup/Assets.xcassets/MenuBarIcon.imageset/Contents.json`
- Create: `setup-assistant/DJToolkitSetup/Assets.xcassets/MenuBarIcon.imageset/MenuBarIcon.png` (18x18)
- Create: `setup-assistant/DJToolkitSetup/Assets.xcassets/MenuBarIcon.imageset/MenuBarIcon@2x.png` (36x36)

- [ ] **Step 1: Create the imageset directory and Contents.json**

```bash
mkdir -p setup-assistant/DJToolkitSetup/Assets.xcassets/MenuBarIcon.imageset
```

Write `Contents.json`:

```json
{
  "images" : [
    {
      "filename" : "MenuBarIcon.png",
      "idiom" : "mac",
      "scale" : "1x"
    },
    {
      "filename" : "MenuBarIcon@2x.png",
      "idiom" : "mac",
      "scale" : "2x"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  },
  "properties" : {
    "template-rendering-intent" : "template"
  }
}
```

Note the `"template-rendering-intent": "template"` — this tells macOS to auto-tint for light/dark mode.

- [ ] **Step 2: Generate icon PNGs from the existing app icon**

Use `sips` to resize the 1024px source icon to 18px and 36px monochrome versions:

```bash
# Create a grayscale version first, then resize
sips -s format png --resampleHeightWidth 36 36 setup-assistant/icon/AppIcon_1024.png --out setup-assistant/DJToolkitSetup/Assets.xcassets/MenuBarIcon.imageset/MenuBarIcon@2x.png
sips -s format png --resampleHeightWidth 18 18 setup-assistant/icon/AppIcon_1024.png --out setup-assistant/DJToolkitSetup/Assets.xcassets/MenuBarIcon.imageset/MenuBarIcon.png
```

Note: For best results, the template icon should be a **monochrome silhouette** (black shape on transparent background). The auto-generated resize from the full color icon may need manual cleanup — the implementer should verify the result looks clean at 18px in the menu bar. If the auto-resize doesn't look good, create a simplified silhouette manually.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/Assets.xcassets/MenuBarIcon.imageset/
git commit -m "feat(macos-tray): add menu bar template icon asset"
```

---

### Task 7: MenuBarManager — the main tray controller

**Files:**
- Create: `setup-assistant/DJToolkitSetup/MenuBar/MenuBarManager.swift`

This is the largest file — creates the NSStatusItem, builds the context menu, handles all actions, and composites the status dot on the icon.

- [ ] **Step 1: Create MenuBarManager.swift**

```swift
import AppKit
import SwiftUI

final class MenuBarManager {
    private var statusItem: NSStatusItem?
    private let agentMonitor = AgentMonitor()
    private var popover: NSPopover?
    private var observation: Any?

    private static let plistPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/LaunchAgents/com.djtoolkit.agent.plist")

    func setup() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem?.button?.target = self
        statusItem?.button?.action = #selector(statusItemClicked)
        statusItem?.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])

        // Observe status changes — re-registers on each change
        observeStatus()

        agentMonitor.startPolling()
        updateIcon()
    }

    func teardown() {
        agentMonitor.stopPolling()
        if let statusItem {
            NSStatusBar.system.removeStatusItem(statusItem)
        }
        statusItem = nil
    }

    // MARK: - Status observation

    private func observeStatus() {
        observation = withObservationTracking {
            _ = agentMonitor.status
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.updateIcon()
                self?.observeStatus()
            }
        }
    }

    // MARK: - Icon compositing

    private func updateIcon() {
        guard let button = statusItem?.button else { return }

        let baseImage = NSImage(named: "MenuBarIcon")
        baseImage?.isTemplate = true

        guard let base = baseImage else {
            button.image = NSImage(systemSymbolName: "music.note", accessibilityDescription: "djtoolkit")
            return
        }

        let status = agentMonitor.status

        // Set tooltip
        switch status {
        case .running:
            button.toolTip = "djtoolkit Agent — Running"
        case .stopped:
            button.toolTip = "djtoolkit Agent — Stopped"
        case .notInstalled:
            button.toolTip = "djtoolkit Agent — Not Installed"
        }

        // Composite status dot
        let dotColor: NSColor? = switch status {
        case .running: .systemGreen
        case .stopped: nil // no dot
        case .notInstalled: .systemYellow
        }

        guard let dotColor else {
            button.image = base
            return
        }

        let size = base.size
        let composited = NSImage(size: size)
        composited.lockFocus()
        base.draw(in: NSRect(origin: .zero, size: size))

        let dotSize: CGFloat = 6
        let dotRect = NSRect(
            x: size.width - dotSize - 1,
            y: 1,
            width: dotSize,
            height: dotSize
        )
        dotColor.setFill()
        NSBezierPath(ovalIn: dotRect).fill()
        composited.unlockFocus()

        // Composited image must NOT be template to preserve dot color
        composited.isTemplate = false
        button.image = composited
    }

    // MARK: - Menu

    @objc private func statusItemClicked() {
        let menu = buildMenu()
        statusItem?.menu = menu
        statusItem?.button?.performClick(nil)
        // Clear menu after showing so next click re-builds with fresh state
        DispatchQueue.main.async { [weak self] in
            self?.statusItem?.menu = nil
        }
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        let status = agentMonitor.status

        // Status line
        let statusText: String
        let statusIcon: String
        switch status {
        case .running:
            statusText = "Running"
            statusIcon = "🟢"
        case .stopped:
            statusText = "Stopped"
            statusIcon = "⚫"
        case .notInstalled:
            statusText = "Not Installed — run Setup to configure"
            statusIcon = "🟡"
        }

        let headerItem = NSMenuItem(title: "djtoolkit Agent", action: nil, keyEquivalent: "")
        headerItem.isEnabled = false
        headerItem.attributedTitle = NSAttributedString(
            string: "djtoolkit Agent",
            attributes: [.font: NSFont.menuFont(ofSize: 13).bold()]
        )
        menu.addItem(headerItem)

        let statusItem = NSMenuItem(title: "\(statusIcon) \(statusText)", action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        menu.addItem(statusItem)

        menu.addItem(.separator())

        // Start/Stop
        let startItem = NSMenuItem(title: "Start Agent", action: #selector(startAgent), keyEquivalent: "")
        startItem.target = self
        startItem.isEnabled = status == .stopped
        menu.addItem(startItem)

        let stopItem = NSMenuItem(title: "Stop Agent", action: #selector(stopAgent), keyEquivalent: "")
        stopItem.target = self
        stopItem.isEnabled = status == .running
        menu.addItem(stopItem)

        menu.addItem(.separator())

        // Run at Startup
        let startupItem = NSMenuItem(title: "Run at Startup", action: #selector(toggleStartup), keyEquivalent: "")
        startupItem.target = self
        startupItem.state = LoginItemManager.isEnabled ? .on : .off
        menu.addItem(startupItem)

        menu.addItem(.separator())

        // Utility actions
        let openDownloads = NSMenuItem(title: "Open Downloads Folder", action: #selector(openDownloadsFolder), keyEquivalent: "")
        openDownloads.target = self
        menu.addItem(openDownloads)

        let openLogs = NSMenuItem(title: "Open Logs", action: #selector(openLogs), keyEquivalent: "")
        openLogs.target = self
        menu.addItem(openLogs)

        let recentActivity = NSMenuItem(title: "Recent Activity...", action: #selector(showRecentActivity), keyEquivalent: "")
        recentActivity.target = self
        menu.addItem(recentActivity)

        menu.addItem(.separator())

        let openDashboard = NSMenuItem(title: "Open Web Dashboard", action: #selector(openWebDashboard), keyEquivalent: "")
        openDashboard.target = self
        menu.addItem(openDashboard)

        let rerunSetup = NSMenuItem(title: "Re-run Setup...", action: #selector(rerunSetup), keyEquivalent: "")
        rerunSetup.target = self
        menu.addItem(rerunSetup)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        return menu
    }

    // MARK: - Actions

    @objc private func startAgent() {
        runLaunchctl(["load", Self.plistPath.path])
    }

    @objc private func stopAgent() {
        runLaunchctl(["unload", Self.plistPath.path])
    }

    private func runLaunchctl(_ arguments: [String], suppressErrors: Bool = false) {
        let process = Process()
        let stderrPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = stderrPipe

        do {
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus != 0 && !suppressErrors {
                let data = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                let stderr = String(data: data, encoding: .utf8) ?? "Unknown error"
                showAlert(title: "launchctl failed", message: stderr)
            }
        } catch {
            showAlert(title: "Failed to run launchctl", message: error.localizedDescription)
        }

        // Refresh immediately instead of waiting for next poll
        agentMonitor.checkStatus()
    }

    @objc private func toggleStartup() {
        if LoginItemManager.isEnabled {
            LoginItemManager.disable()
            // Also stop the agent
            runLaunchctl(["unload", Self.plistPath.path])
        } else {
            do {
                try LoginItemManager.enable()
                // Also load the LaunchAgent — suppress "already loaded" errors
                runLaunchctl(["load", Self.plistPath.path], suppressErrors: true)
            } catch {
                showAlert(title: "Failed to enable login item", message: error.localizedDescription)
            }
        }
    }

    @objc private func openDownloadsFolder() {
        let path = ConfigReader.downloadsDir
        let url = URL(fileURLWithPath: path)
        NSWorkspace.shared.open(url)
    }

    @objc private func openLogs() {
        let path = ConfigReader.logFilePath
        if FileManager.default.fileExists(atPath: path) {
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        } else {
            showAlert(title: "No Logs", message: "No log file found. Start the agent first.")
        }
    }

    @objc private func showRecentActivity() {
        guard let button = statusItem?.button else { return }

        if let existingPopover = popover, existingPopover.isShown {
            existingPopover.close()
            popover = nil
            return
        }

        let jobs = StatusReader.recentJobs()
        let view = ActivityPopoverView(jobs: jobs)
        let hostingController = NSHostingController(rootView: view)

        let newPopover = NSPopover()
        newPopover.contentViewController = hostingController
        newPopover.behavior = .transient
        newPopover.contentSize = NSSize(width: 320, height: 380)
        newPopover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover = newPopover
    }

    @objc private func openWebDashboard() {
        if let url = URL(string: "https://app.djtoolkit.net") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func rerunSetup() {
        guard let executablePath = Bundle.main.executablePath else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executablePath)
        process.arguments = [] // no --tray
        try? process.run()
    }

    @objc private func quit() {
        cleanupPIDFile()
        NSApp.terminate(nil)
    }

    /// Clean up PID file — called from quit() and applicationWillTerminate
    func cleanupPIDFile() {
        let pidPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".djtoolkit/tray.pid")
        try? FileManager.default.removeItem(at: pidPath)
    }

    // MARK: - Helpers

    private func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

// MARK: - NSFont extension

private extension NSFont {
    func bold() -> NSFont {
        NSFontManager.shared.convert(self, toHaveTrait: .boldFontMask)
    }
}
```

- [ ] **Step 2: Verify it compiles**

Build the project as in Task 1 Step 2.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/MenuBar/MenuBarManager.swift
git commit -m "feat(macos-tray): add MenuBarManager with context menu and actions"
```

---

### Task 8: Dual-mode app entry point

**Files:**
- Modify: `setup-assistant/DJToolkitSetup/DJToolkitSetupApp.swift`

This is the integration point — parse `--tray`, manage PID file, branch between wizard and menu bar mode.

- [ ] **Step 1: Modify DJToolkitSetupApp.swift**

Replace the entire file with:

```swift
import SwiftUI

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillTerminate(_ notification: Notification) {
        DJToolkitSetupApp.menuBarManager?.cleanupPIDFile()
    }
}

@main
struct DJToolkitSetupApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @State private var state = SetupState()
    static let isTrayMode = CommandLine.arguments.contains("--tray")
    static var menuBarManager: MenuBarManager?

    var body: some Scene {
        WindowGroup {
            if Self.isTrayMode {
                // Empty view — menu bar mode has no window
                Color.clear
                    .frame(width: 0, height: 0)
                    .onAppear { setupTrayMode() }
            } else {
                ContentView()
                    .environment(state)
                    .frame(width: 520, height: 480)
                    .fixedSize()
                    .task {
                        if CLIBridge.findBinary() == nil {
                            do {
                                _ = try CLIBridge.installBinaryFromDMG()
                            } catch {
                                state.errorMessage = error.localizedDescription
                            }
                        }
                    }
            }
        }
        .windowResizability(.contentSize)
    }

    private func setupTrayMode() {
        // Single instance guard via PID file
        let pidPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".djtoolkit/tray.pid")

        if let existingPID = readPID(at: pidPath), isProcessRunning(pid: existingPID) {
            // Another tray instance is running — exit silently
            NSApp.terminate(nil)
            return
        }

        // Write our PID
        let configDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".djtoolkit")
        try? FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)
        try? "\(ProcessInfo.processInfo.processIdentifier)".write(to: pidPath, atomically: true, encoding: .utf8)

        // Hide from Dock
        NSApp.setActivationPolicy(.accessory)

        // Hide the window
        for window in NSApp.windows {
            window.close()
        }

        // Start menu bar
        let manager = MenuBarManager()
        manager.setup()
        Self.menuBarManager = manager
    }

    private func readPID(at url: URL) -> pid_t? {
        guard let contents = try? String(contentsOf: url, encoding: .utf8),
              let pid = pid_t(contents.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }
        return pid
    }

    private func isProcessRunning(pid: pid_t) -> Bool {
        // kill with signal 0 checks if process exists without sending a signal
        return kill(pid, 0) == 0
    }
}

struct ContentView: View {
    @Environment(SetupState.self) private var state

    var body: some View {
        Group {
            switch state.currentStep {
            case .welcome:
                WelcomeView()
            case .signIn:
                SignInView()
            case .soulseek:
                SoulseekView()
            case .acoustID:
                AcoustIDView()
            case .confirm:
                ConfirmView()
            case .done:
                DoneView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: state.currentStep)
    }
}
```

- [ ] **Step 2: Verify it compiles and wizard mode still works**

Build the project:
```bash
xcodebuild -project setup-assistant/DJToolkitSetup.xcodeproj -scheme DJToolkitSetup -configuration Debug build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/DJToolkitSetupApp.swift
git commit -m "feat(macos-tray): add dual-mode entry point with --tray flag"
```

---

### Task 9: Add new files to Xcode project

**Files:**
- Modify: `setup-assistant/DJToolkitSetup.xcodeproj/project.pbxproj`

All new `.swift` files must be registered in the Xcode project's build phases. The easiest approach is to add them via `xcodebuild` or by editing `project.pbxproj`.

- [ ] **Step 1: Add files to the Xcode project**

Use the `xcodeproj` Ruby gem (bundled with Xcode's Ruby) to add files programmatically:

```ruby
#!/usr/bin/env ruby
require 'xcodeproj'

project_path = 'setup-assistant/DJToolkitSetup.xcodeproj'
project = Xcodeproj::Project.open(project_path)
target = project.targets.find { |t| t.name == 'DJToolkitSetup' }

# Get or create the MenuBar group
djt_group = project.main_group['DJToolkitSetup'] || project.main_group
menubar_group = djt_group['MenuBar'] || djt_group.new_group('MenuBar', 'DJToolkitSetup/MenuBar')
views_group = djt_group['Views'] || djt_group.new_group('Views', 'DJToolkitSetup/Views')

# Add MenuBar Swift files
%w[
  AgentMonitor.swift
  MenuBarManager.swift
  ConfigReader.swift
  StatusReader.swift
  LoginItemManager.swift
].each do |filename|
  path = "DJToolkitSetup/MenuBar/#{filename}"
  ref = menubar_group.new_file(path)
  target.source_build_phase.add_file_reference(ref)
end

# Add ActivityPopoverView
ref = views_group.new_file('DJToolkitSetup/Views/ActivityPopoverView.swift')
target.source_build_phase.add_file_reference(ref)

# MenuBarIcon.imageset is inside Assets.xcassets — no extra step needed
# (Xcode picks up all imagesets inside .xcassets automatically)

project.save
puts "Added 6 files to target '#{target.name}'"
```

Run from the repo root:
```bash
cd setup-assistant && ruby add_menubar_files.rb && rm add_menubar_files.rb && cd ..
```

If `xcodeproj` gem is not available, install it with `gem install xcodeproj` or add the files manually via `xed setup-assistant/DJToolkitSetup.xcodeproj` (drag files into the project navigator and ensure they're added to the DJToolkitSetup target).

- [ ] **Step 2: Verify full project builds**

```bash
xcodebuild -project setup-assistant/DJToolkitSetup.xcodeproj -scheme DJToolkitSetup -configuration Release build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -10
```

Expected: BUILD SUCCEEDED

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup.xcodeproj/
git commit -m "feat(macos-tray): register new files in Xcode project"
```

---

### Task 10: End-to-end verification

- [ ] **Step 1: Build Release and verify both modes**

```bash
# Build
xcodebuild -project setup-assistant/DJToolkitSetup.xcodeproj \
  -scheme DJToolkitSetup \
  -configuration Release \
  build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -10
```

Expected: BUILD SUCCEEDED

- [ ] **Step 2: Verify CI build still passes**

The `ci-agents.yml` workflow builds using the same xcodebuild command. Since we only added Swift files and an asset catalog imageset, the CI build should pass. Check that the `Config.xcconfig.ci` step still works:

```bash
cp setup-assistant/Config.xcconfig.ci setup-assistant/Config.xcconfig
xcodebuild -project setup-assistant/DJToolkitSetup.xcodeproj \
  -scheme DJToolkitSetup \
  -configuration Release \
  build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -10
```

- [ ] **Step 3: Final commit with all files**

```bash
git add -A setup-assistant/
git status
git commit -m "feat(macos-tray): macOS menu bar app for agent management

Adds tray mode to the existing Setup Assistant app. Launch with
--tray flag for a menu bar icon with agent control, status monitoring,
and recent activity popover. No-args still shows the setup wizard."
```

---

## Phase 2: New Features (Auto-Update, Reconfigure, Uninstall)

These tasks build on top of Phase 1 (Tasks 1-10). They add auto-update from GitHub Releases, a lightweight config editor, agent uninstall, periodic version checking with notifications, and first-run wizard auto-launch.

---

### Task 11: UpdateChecker — GitHub Releases API + version comparison

**Files:**
- Create: `setup-assistant/DJToolkitSetup/MenuBar/UpdateChecker.swift`

Queries `api.github.com/repos/yenkz/djtoolkit/releases/latest`, compares with current bundle version, downloads `.pkg` installer when user triggers update.

- [ ] **Step 1: Create UpdateChecker.swift**

```swift
import Foundation
import Observation

@Observable
final class UpdateChecker {
    private(set) var updateAvailable = false
    private(set) var latestVersion: String?
    private(set) var downloadURL: URL?
    private(set) var isDownloading = false

    private var timer: Timer?
    private static let apiURL = URL(string: "https://api.github.com/repos/yenkz/djtoolkit/releases/latest")!
    private static let checkIntervalKey = "lastUpdateCheck"
    private static let notifiedVersionKey = "lastNotifiedVersion"

    var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    /// Start periodic checking (every 24h) + initial delayed check (5s)
    func startPeriodicChecks() {
        // Delayed initial check
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.checkForUpdates()
        }

        // 24h timer
        timer = Timer.scheduledTimer(withTimeInterval: 86400, repeats: true) { [weak self] _ in
            self?.checkForUpdates()
        }
    }

    func stopPeriodicChecks() {
        timer?.invalidate()
        timer = nil
    }

    /// Check GitHub Releases API for a newer version
    func checkForUpdates() {
        var request = URLRequest(url: Self.apiURL)
        request.setValue("application/vnd.github.v3+json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self,
                  let data,
                  let http = response as? HTTPURLResponse,
                  http.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tagName = json["tag_name"] as? String,
                  let assets = json["assets"] as? [[String: Any]] else {
                return // Silent failure
            }

            let remoteVersion = tagName.hasPrefix("v") ? String(tagName.dropFirst()) : tagName

            guard self.isNewer(remote: remoteVersion, current: self.currentVersion) else {
                DispatchQueue.main.async {
                    self.updateAvailable = false
                    self.latestVersion = nil
                    self.downloadURL = nil
                }
                return
            }

            // Find .pkg asset
            let pkgAsset = assets.first { asset in
                guard let name = asset["name"] as? String else { return false }
                return name.hasSuffix(".pkg")
            }

            let pkgURL = (pkgAsset?["browser_download_url"] as? String).flatMap(URL.init(string:))

            DispatchQueue.main.async {
                self.updateAvailable = true
                self.latestVersion = remoteVersion
                self.downloadURL = pkgURL

                UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.checkIntervalKey)
            }
        }.resume()
    }

    /// Download and launch the .pkg installer
    func downloadAndInstall() {
        guard let downloadURL else { return }
        isDownloading = true

        let tempDir = FileManager.default.temporaryDirectory
        let destURL = tempDir.appendingPathComponent("djtoolkit-update.pkg")

        // Remove old download if exists
        try? FileManager.default.removeItem(at: destURL)

        URLSession.shared.downloadTask(with: downloadURL) { [weak self] tempURL, response, error in
            DispatchQueue.main.async {
                self?.isDownloading = false
            }

            guard let tempURL, error == nil else {
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = "Update Download Failed"
                    alert.informativeText = "Could not download the update. Try again later."
                    alert.alertStyle = .warning
                    alert.addButton(withTitle: "OK")
                    alert.runModal()
                }
                return
            }

            do {
                try FileManager.default.moveItem(at: tempURL, to: destURL)
                // Launch the .pkg installer
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                process.arguments = [destURL.path]
                try process.run()

                // Quit after a brief delay to let the installer launch
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    NSApp.terminate(nil)
                }
            } catch {
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = "Update Failed"
                    alert.informativeText = error.localizedDescription
                    alert.alertStyle = .warning
                    alert.addButton(withTitle: "OK")
                    alert.runModal()
                }
            }
        }.resume()
    }

    /// Semantic version comparison: is remote > current?
    private func isNewer(remote: String, current: String) -> Bool {
        let remoteParts = remote.split(separator: ".").compactMap { Int($0) }
        let currentParts = current.split(separator: ".").compactMap { Int($0) }

        for i in 0..<max(remoteParts.count, currentParts.count) {
            let r = i < remoteParts.count ? remoteParts[i] : 0
            let c = i < currentParts.count ? currentParts[i] : 0
            if r > c { return true }
            if r < c { return false }
        }
        return false
    }

    /// Whether a notification has already been sent for this version
    func shouldNotify() -> Bool {
        guard let latestVersion else { return false }
        let lastNotified = UserDefaults.standard.string(forKey: Self.notifiedVersionKey)
        return lastNotified != latestVersion
    }

    /// Mark notification as sent for current latest version
    func markNotified() {
        guard let latestVersion else { return }
        UserDefaults.standard.set(latestVersion, forKey: Self.notifiedVersionKey)
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `xcodebuild -project setup-assistant/DJToolkitSetup.xcodeproj -scheme DJToolkitSetup -configuration Debug build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -5`

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/MenuBar/UpdateChecker.swift
git commit -m "feat(macos-tray): add UpdateChecker for GitHub Releases auto-update"
```

---

### Task 12: Update notification support

**Files:**
- Create: `setup-assistant/DJToolkitSetup/MenuBar/NotificationManager.swift`

Sends native macOS notification when a new version is discovered. Requests authorization on first use.

- [ ] **Step 1: Create NotificationManager.swift**

```swift
import UserNotifications

enum NotificationManager {
    private static let center = UNUserNotificationCenter.current()

    /// Request notification permission (call once on tray launch)
    static func requestAuthorization() {
        center.requestAuthorization(options: [.alert]) { _, _ in }
    }

    /// Send an update-available notification
    static func sendUpdateNotification(version: String) {
        let content = UNMutableNotificationContent()
        content.title = "djtoolkit Update Available"
        content.body = "Version \(version) is ready to install."
        content.categoryIdentifier = "UPDATE"

        let request = UNNotificationRequest(
            identifier: "update-\(version)",
            content: content,
            trigger: nil // deliver immediately
        )
        center.add(request)
    }
}
```

- [ ] **Step 2: Verify it compiles**

Build the project as in Task 11 Step 2.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/MenuBar/NotificationManager.swift
git commit -m "feat(macos-tray): add NotificationManager for update notifications"
```

---

### Task 13: ConfigWriter — regex-based TOML write

**Files:**
- Create: `setup-assistant/DJToolkitSetup/MenuBar/ConfigWriter.swift`

Read-modify-write of `config.toml` using line-based string replacement. Only 3 keys are editable so regex is sufficient.

- [ ] **Step 1: Create ConfigWriter.swift**

```swift
import Foundation

enum ConfigWriter {
    private static let configPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".djtoolkit/config.toml")

    struct Config {
        var downloadsDir: String
        var soulseekUsername: String
        var soulseekPassword: String
    }

    /// Read editable config values from config.toml
    static func readConfig() -> Config {
        let defaults = Config(
            downloadsDir: ConfigReader.downloadsDir,
            soulseekUsername: "",
            soulseekPassword: ""
        )

        guard let contents = try? String(contentsOf: configPath, encoding: .utf8) else {
            return defaults
        }

        var config = defaults
        var inSoulseekSection = false
        var inAgentSection = false

        for line in contents.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Track TOML sections
            if trimmed.hasPrefix("[") {
                inSoulseekSection = trimmed.hasPrefix("[soulseek]")
                inAgentSection = trimmed.hasPrefix("[agent]")
                continue
            }

            if inAgentSection {
                if let value = extractValue(trimmed, key: "downloads_dir") {
                    config.downloadsDir = value
                }
            }
            if inSoulseekSection {
                if let value = extractValue(trimmed, key: "username") {
                    config.soulseekUsername = value
                } else if let value = extractValue(trimmed, key: "password") {
                    config.soulseekPassword = value
                }
            }
        }

        return config
    }

    /// Write updated config values back to config.toml (read-modify-write)
    static func writeConfig(_ config: Config) throws {
        let configDir = configPath.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)

        var lines: [String]
        if let contents = try? String(contentsOf: configPath, encoding: .utf8) {
            lines = contents.components(separatedBy: "\n")
        } else {
            // Create minimal config structure
            lines = [
                "[agent]",
                "downloads_dir = \"\(config.downloadsDir)\"",
                "",
                "[soulseek]",
                "username = \"\(config.soulseekUsername)\"",
                "password = \"\(config.soulseekPassword)\"",
            ]
            try lines.joined(separator: "\n").write(to: configPath, atomically: true, encoding: .utf8)
            return
        }

        // Replace or insert values
        var foundDownloads = false
        var foundSlskUser = false
        var foundSlskPass = false
        var inSoulseekSection = false
        var inAgentSection = false

        for i in 0..<lines.count {
            let trimmed = lines[i].trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("[") {
                inSoulseekSection = trimmed.hasPrefix("[soulseek]")
                inAgentSection = trimmed.hasPrefix("[agent]")
                continue
            }

            if inAgentSection && trimmed.hasPrefix("downloads_dir") {
                lines[i] = "downloads_dir = \"\(config.downloadsDir)\""
                foundDownloads = true
            }
            if inSoulseekSection && trimmed.hasPrefix("username") {
                lines[i] = "username = \"\(config.soulseekUsername)\""
                foundSlskUser = true
            }
            if inSoulseekSection && trimmed.hasPrefix("password") {
                lines[i] = "password = \"\(config.soulseekPassword)\""
                foundSlskPass = true
            }
        }

        // Append missing keys to their sections (or create sections)
        if !foundDownloads {
            appendToSection(&lines, section: "[agent]",
                            line: "downloads_dir = \"\(config.downloadsDir)\"")
        }
        if !foundSlskUser {
            appendToSection(&lines, section: "[soulseek]",
                            line: "username = \"\(config.soulseekUsername)\"")
        }
        if !foundSlskPass {
            appendToSection(&lines, section: "[soulseek]",
                            line: "password = \"\(config.soulseekPassword)\"")
        }

        try lines.joined(separator: "\n").write(to: configPath, atomically: true, encoding: .utf8)
    }

    // MARK: - Helpers

    private static func extractValue(_ line: String, key: String) -> String? {
        guard line.hasPrefix(key), let eqIndex = line.firstIndex(of: "=") else {
            return nil
        }
        var value = line[line.index(after: eqIndex)...].trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("\"") && value.hasSuffix("\"") {
            value = String(value.dropFirst().dropLast())
        }
        return value.isEmpty ? nil : value
    }

    private static func appendToSection(_ lines: inout [String], section: String, line: String) {
        if let sectionIdx = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == section }) {
            lines.insert(line, at: sectionIdx + 1)
        } else {
            // Create section at end
            lines.append("")
            lines.append(section)
            lines.append(line)
        }
    }
}
```

- [ ] **Step 2: Verify it compiles**

Build the project as in Task 11 Step 2.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/MenuBar/ConfigWriter.swift
git commit -m "feat(macos-tray): add ConfigWriter for TOML read-modify-write"
```

---

### Task 14: ReconfigureView — lightweight config editor

**Files:**
- Create: `setup-assistant/DJToolkitSetup/Views/ReconfigureView.swift`

SwiftUI form displayed in an NSWindow for editing downloads dir, Soulseek creds.

- [ ] **Step 1: Create ReconfigureView.swift**

```swift
import SwiftUI

struct ReconfigureView: View {
    @State private var downloadsDir: String = ""
    @State private var soulseekUsername: String = ""
    @State private var soulseekPassword: String = ""
    @State private var showSaved = false
    @State private var errorMessage: String?
    @Environment(\.dismiss) private var dismiss

    private let agentRunning: Bool

    init(agentRunning: Bool) {
        self.agentRunning = agentRunning
    }

    var body: some View {
        Form {
            Section("Downloads") {
                HStack {
                    TextField("Downloads Directory", text: $downloadsDir)
                        .textFieldStyle(.roundedBorder)
                    Button("Browse...") { pickFolder() }
                }
            }

            Section("Soulseek") {
                TextField("Username", text: $soulseekUsername)
                    .textFieldStyle(.roundedBorder)
                SecureField("Password", text: $soulseekPassword)
                    .textFieldStyle(.roundedBorder)
            }

            if let errorMessage {
                Text(errorMessage)
                    .foregroundStyle(.red)
                    .font(.caption)
            }

            if showSaved {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text("Saved")
                    if agentRunning {
                        Text("— restart the agent for changes to take effect.")
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save") { save() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.top, 8)
        }
        .padding(20)
        .frame(width: 400, height: 280)
        .onAppear { loadConfig() }
    }

    private func loadConfig() {
        let config = ConfigWriter.readConfig()
        downloadsDir = config.downloadsDir
        soulseekUsername = config.soulseekUsername
        soulseekPassword = config.soulseekPassword
    }

    private func save() {
        let config = ConfigWriter.Config(
            downloadsDir: downloadsDir,
            soulseekUsername: soulseekUsername,
            soulseekPassword: soulseekPassword
        )
        do {
            try ConfigWriter.writeConfig(config)
            errorMessage = nil
            showSaved = true
            // Auto-dismiss after 2s
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                showSaved = false
            }
        } catch {
            errorMessage = "Failed to save: \(error.localizedDescription)"
        }
    }

    private func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Select Downloads Folder"
        if panel.runModal() == .OK, let url = panel.url {
            downloadsDir = url.path
        }
    }
}
```

- [ ] **Step 2: Verify it compiles**

Build the project as in Task 11 Step 2.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/Views/ReconfigureView.swift
git commit -m "feat(macos-tray): add ReconfigureView for lightweight config editing"
```

---

### Task 15: Uninstaller — agent removal logic

**Files:**
- Create: `setup-assistant/DJToolkitSetup/MenuBar/Uninstaller.swift`

Handles all uninstall steps: stop agent, remove plist, CLI binary, login item, optionally config dir. Detects Homebrew installs.

- [ ] **Step 1: Create Uninstaller.swift**

```swift
import AppKit
import ServiceManagement

enum UninstallLevel {
    case keepSettings  // remove agent + binary, keep ~/.djtoolkit
    case removeAll     // remove everything including ~/.djtoolkit
}

enum Uninstaller {
    private static let plistPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/LaunchAgents/com.djtoolkit.agent.plist")
    private static let configDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".djtoolkit")
    private static let logDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/djtoolkit")

    /// Show uninstall confirmation dialog. Returns true if user confirmed.
    static func showConfirmation() -> UninstallLevel? {
        let alert = NSAlert()
        alert.messageText = "Uninstall djtoolkit Agent?"
        alert.informativeText = "This will stop the agent service, remove the CLI tool, and remove auto-start entries."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Uninstall (keep settings)")
        alert.addButton(withTitle: "Uninstall (remove everything)")
        alert.addButton(withTitle: "Cancel")

        let response = alert.runModal()
        switch response {
        case .alertFirstButtonReturn: return .keepSettings
        case .alertSecondButtonReturn: return .removeAll
        default: return nil
        }
    }

    /// Perform uninstall. Returns list of any errors encountered.
    static func uninstall(level: UninstallLevel) -> [String] {
        var errors: [String] = []

        // 1. Stop agent
        if FileManager.default.fileExists(atPath: plistPath.path) {
            let result = runProcess("/bin/launchctl", ["unload", plistPath.path])
            if let err = result { errors.append("Stop agent: \(err)") }
        }

        // 2. Remove LaunchAgent plist
        do {
            if FileManager.default.fileExists(atPath: plistPath.path) {
                try FileManager.default.removeItem(at: plistPath)
            }
        } catch {
            errors.append("Remove plist: \(error.localizedDescription)")
        }

        // 3. Remove CLI binary
        removeCLIBinary(&errors)

        // 4. Remove login item
        try? SMAppService.mainApp.unregister()

        // 5. Remove log files
        do {
            if FileManager.default.fileExists(atPath: logDir.path) {
                try FileManager.default.removeItem(at: logDir)
            }
        } catch {
            errors.append("Remove logs: \(error.localizedDescription)")
        }

        // 6. Remove config/data (if full cleanup)
        if level == .removeAll {
            do {
                if FileManager.default.fileExists(atPath: configDir.path) {
                    try FileManager.default.removeItem(at: configDir)
                }
            } catch {
                errors.append("Remove config: \(error.localizedDescription)")
            }
        }

        return errors
    }

    /// Show completion dialog and quit
    static func showCompletionAndQuit(errors: [String]) {
        let alert = NSAlert()
        if errors.isEmpty {
            alert.messageText = "djtoolkit has been uninstalled."
            alert.informativeText = "The agent and all associated files have been removed."
            alert.alertStyle = .informational
        } else {
            alert.messageText = "Uninstall completed with warnings"
            alert.informativeText = "Some items could not be removed:\n\n" + errors.joined(separator: "\n")
            alert.alertStyle = .warning
        }
        alert.addButton(withTitle: "OK")
        alert.runModal()

        // Clean up PID file and quit
        let pidPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".djtoolkit/tray.pid")
        try? FileManager.default.removeItem(at: pidPath)
        NSApp.terminate(nil)
    }

    // MARK: - Helpers

    private static func removeCLIBinary(_ errors: inout [String]) {
        // Use the same discovery as CLIBridge
        let candidates = [
            "/opt/homebrew/bin/djtoolkit",
            "/usr/local/bin/djtoolkit",
        ]

        guard let binaryPath = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            // Try `which`
            if let whichResult = runProcessOutput("/usr/bin/which", ["djtoolkit"]),
               !whichResult.isEmpty {
                let path = whichResult.trimmingCharacters(in: .whitespacesAndNewlines)
                if isHomebrewPath(path) {
                    showHomebrewWarning()
                    return
                }
                removeWithAdminPrompt(path, &errors)
            }
            return
        }

        if isHomebrewPath(binaryPath) {
            showHomebrewWarning()
            return
        }

        removeWithAdminPrompt(binaryPath, &errors)
    }

    private static func isHomebrewPath(_ path: String) -> Bool {
        path.contains("/homebrew/") || path.contains("/Cellar/")
    }

    private static func showHomebrewWarning() {
        let alert = NSAlert()
        alert.messageText = "Homebrew Installation Detected"
        alert.informativeText = "The djtoolkit CLI was installed via Homebrew. Please run:\n\nbrew uninstall djtoolkit\n\nto remove it properly."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private static func removeWithAdminPrompt(_ path: String, _ errors: inout [String]) {
        let script = "do shell script \"rm -f \(path)\" with administrator privileges"
        if let appleScript = NSAppleScript(source: script) {
            var errorInfo: NSDictionary?
            appleScript.executeAndReturnError(&errorInfo)
            if let errorInfo {
                errors.append("Remove CLI binary: \(errorInfo)")
            }
        }
    }

    private static func runProcess(_ executablePath: String, _ arguments: [String]) -> String? {
        let process = Process()
        let stderrPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executablePath)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = stderrPipe

        do {
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus != 0 {
                let data = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                return String(data: data, encoding: .utf8) ?? "exit code \(process.terminationStatus)"
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    private static func runProcessOutput(_ executablePath: String, _ arguments: [String]) -> String? {
        let process = Process()
        let stdoutPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executablePath)
        process.arguments = arguments
        process.standardOutput = stdoutPipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)
        } catch {
            return nil
        }
    }
}
```

- [ ] **Step 2: Verify it compiles**

Build the project as in Task 11 Step 2.

- [ ] **Step 3: Commit**

```bash
git add setup-assistant/DJToolkitSetup/MenuBar/Uninstaller.swift
git commit -m "feat(macos-tray): add Uninstaller with cleanup level choice"
```

---

### Task 16: Integrate new features into MenuBarManager

**Files:**
- Modify: `setup-assistant/DJToolkitSetup/MenuBar/MenuBarManager.swift`

Add UpdateChecker, new menu items (Reconfigure, Check for Updates, Uninstall), update badge, and notification trigger.

- [ ] **Step 1: Add UpdateChecker and notification support to MenuBarManager**

Add these properties after `private var observation: Any?`:

```swift
    private let updateChecker = UpdateChecker()
    private var updateObservation: Any?
    private var reconfigureWindow: NSWindow?
```

Add this to `setup()` after `agentMonitor.startPolling()`:

```swift
        // Start update checker
        NotificationManager.requestAuthorization()
        updateChecker.startPeriodicChecks()
        observeUpdates()
```

Add the `observeUpdates()` method after `observeStatus()`:

```swift
    private func observeUpdates() {
        updateObservation = withObservationTracking {
            _ = updateChecker.updateAvailable
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.updateIcon()
                self?.observeUpdates()
                // Send notification for new version
                if let self, self.updateChecker.shouldNotify() {
                    if let version = self.updateChecker.latestVersion {
                        NotificationManager.sendUpdateNotification(version: version)
                        self.updateChecker.markNotified()
                    }
                }
            }
        }
    }
```

- [ ] **Step 2: Add update badge to `updateIcon()`**

After the existing status dot compositing, add a blue update dot at top-right. Replace the `updateIcon()` method's compositing section. After `composited.lockFocus()` and `base.draw(...)`, add before `composited.unlockFocus()`:

```swift
        // Update badge (top-right) — blue dot when update available
        if updateChecker.updateAvailable {
            NSColor.systemBlue.setFill()
            let badgeRect = NSRect(
                x: size.width - dotSize - 1,
                y: size.height - dotSize - 1,
                width: dotSize,
                height: dotSize
            )
            NSBezierPath(ovalIn: badgeRect).fill()
        }
```

Also update the method so it always composites (not just when a status dot is needed) if an update badge is needed. Replace the `guard let dotColor else { ... }` block:

```swift
        if dotColor == nil && !updateChecker.updateAvailable {
            button.image = base
            return
        }
```

- [ ] **Step 3: Add new menu items to `buildMenu()`**

Add after the `rerunSetup` item and before the final separator + Quit:

```swift
        menu.addItem(.separator())

        // Check for Updates
        if updateChecker.isDownloading {
            let downloadingItem = NSMenuItem(title: "Downloading update...", action: nil, keyEquivalent: "")
            downloadingItem.isEnabled = false
            menu.addItem(downloadingItem)
        } else if updateChecker.updateAvailable, let version = updateChecker.latestVersion {
            let updateItem = NSMenuItem(title: "Update Available (v\(version))", action: #selector(installUpdate), keyEquivalent: "")
            updateItem.target = self
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.menuFont(ofSize: 13).bold()]
            updateItem.attributedTitle = NSAttributedString(string: "Update Available (v\(version))", attributes: attrs)
            menu.addItem(updateItem)
        } else {
            let checkItem = NSMenuItem(title: "Check for Updates", action: #selector(checkForUpdates), keyEquivalent: "")
            checkItem.target = self
            menu.addItem(checkItem)
        }

        menu.addItem(.separator())

        // Uninstall
        let uninstallItem = NSMenuItem(title: "Uninstall Agent...", action: #selector(uninstallAgent), keyEquivalent: "")
        uninstallItem.target = self
        menu.addItem(uninstallItem)
```

Also add *before* `openDashboard` (so Reconfigure appears before Open Web Dashboard, matching the spec):

```swift
        let reconfigureItem = NSMenuItem(title: "Reconfigure Agent...", action: #selector(openReconfigure), keyEquivalent: "")
        reconfigureItem.target = self
        menu.addItem(reconfigureItem)
```

- [ ] **Step 4: Add action methods**

Add these action methods:

```swift
    @objc private func checkForUpdates() {
        updateChecker.checkForUpdates()
    }

    @objc private func installUpdate() {
        updateChecker.downloadAndInstall()
    }

    @objc private func openReconfigure() {
        if let existing = reconfigureWindow, existing.isVisible {
            existing.makeKeyAndOrderFront(nil)
            return
        }

        let isRunning = agentMonitor.status == .running
        let view = ReconfigureView(agentRunning: isRunning)
        let hostingController = NSHostingController(rootView: view)

        let window = NSWindow(contentViewController: hostingController)
        window.title = "Reconfigure djtoolkit Agent"
        window.styleMask = [.titled, .closable]
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        reconfigureWindow = window
    }

    @objc private func uninstallAgent() {
        guard let level = Uninstaller.showConfirmation() else { return }
        let errors = Uninstaller.uninstall(level: level)
        Uninstaller.showCompletionAndQuit(errors: errors)
    }
```

- [ ] **Step 5: Update `teardown()` to stop update checker**

Add to `teardown()`:

```swift
        updateChecker.stopPeriodicChecks()
```

- [ ] **Step 6: Verify it compiles**

Build the project as in Task 11 Step 2.

- [ ] **Step 7: Commit**

```bash
git add setup-assistant/DJToolkitSetup/MenuBar/MenuBarManager.swift
git commit -m "feat(macos-tray): integrate auto-update, reconfigure, and uninstall into menu"
```

---

### Task 17: First-run detection in DJToolkitSetupApp

**Files:**
- Modify: `setup-assistant/DJToolkitSetup/DJToolkitSetupApp.swift`

When launching with `--tray` and no `config.toml` exists, auto-launch the setup wizard.

- [ ] **Step 1: Add first-run check to `setupTrayMode()`**

Add after `Self.menuBarManager = manager` in the `setupTrayMode()` function:

```swift
        // First-run: if no config exists, auto-launch wizard
        let configPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".djtoolkit/config.toml")
        if !FileManager.default.fileExists(atPath: configPath.path) {
            // Launch wizard (same as Re-run Setup)
            NSWorkspace.shared.openApplication(
                at: Bundle.main.bundleURL,
                configuration: NSWorkspace.OpenConfiguration()
            ) { _, _ in }
        }
```

- [ ] **Step 2: Also update Re-run Setup in MenuBarManager to use NSWorkspace**

In `MenuBarManager.swift`, replace the `rerunSetup()` method:

```swift
    @objc private func rerunSetup() {
        NSWorkspace.shared.openApplication(
            at: Bundle.main.bundleURL,
            configuration: NSWorkspace.OpenConfiguration()
        )
    }
```

- [ ] **Step 3: Verify it compiles**

Build the project as in Task 11 Step 2.

- [ ] **Step 4: Commit**

```bash
git add setup-assistant/DJToolkitSetup/DJToolkitSetupApp.swift setup-assistant/DJToolkitSetup/MenuBar/MenuBarManager.swift
git commit -m "feat(macos-tray): add first-run wizard auto-launch and fix Re-run Setup"
```

---

### Task 18: Add new files to Xcode project + end-to-end verification

**Files:**
- Modify: `setup-assistant/DJToolkitSetup.xcodeproj/project.pbxproj`

- [ ] **Step 1: Add new Phase 2 files to Xcode project**

Using the same approach as Task 9, add these files to the DJToolkitSetup target:
- `MenuBar/UpdateChecker.swift`
- `MenuBar/NotificationManager.swift`
- `MenuBar/ConfigWriter.swift`
- `MenuBar/Uninstaller.swift`
- `Views/ReconfigureView.swift`

Use the `xcodeproj` Ruby gem script or add manually via Xcode.

- [ ] **Step 2: Build Release**

```bash
xcodebuild -project setup-assistant/DJToolkitSetup.xcodeproj \
  -scheme DJToolkitSetup \
  -configuration Release \
  build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -10
```

Expected: BUILD SUCCEEDED

- [ ] **Step 3: Verify CI build**

```bash
cp setup-assistant/Config.xcconfig.ci setup-assistant/Config.xcconfig
xcodebuild -project setup-assistant/DJToolkitSetup.xcodeproj \
  -scheme DJToolkitSetup \
  -configuration Release \
  build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add -A setup-assistant/
git commit -m "feat(macos-tray): phase 2 — auto-update, reconfigure, uninstall, version check

Adds GitHub Releases auto-update with notification, lightweight config
editor, agent uninstaller with Homebrew detection, periodic version
check with blue badge, and first-run wizard auto-launch."
```
