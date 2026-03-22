import AppKit
import ServiceManagement

enum UninstallLevel {
    case keepSettings  // remove agent + binary, keep ~/.djtoolkit
    case removeAll     // remove everything including ~/.djtoolkit
}

enum Uninstaller {
    private static var plistPath: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.djtoolkit.agent.plist")
    }
    private static var configDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".djtoolkit")
    }
    private static var logDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/djtoolkit")
    }

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
