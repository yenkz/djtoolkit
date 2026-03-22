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
| `setup-assistant/DJToolkitSetup/Views/ActivityPopoverView.swift` | SwiftUI list of recent jobs inside NSPopover |
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
