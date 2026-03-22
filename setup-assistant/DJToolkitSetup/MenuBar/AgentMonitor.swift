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
