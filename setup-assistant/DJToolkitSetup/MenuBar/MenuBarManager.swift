import AppKit
import SwiftUI

final class MenuBarManager {
    private var statusItem: NSStatusItem?
    private let agentMonitor = AgentMonitor()
    private var popover: NSPopover?
    private var observation: Any?

    private static var plistPath: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.djtoolkit.agent.plist")
    }

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
        Task { await agentMonitor.refreshStatus() }
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
