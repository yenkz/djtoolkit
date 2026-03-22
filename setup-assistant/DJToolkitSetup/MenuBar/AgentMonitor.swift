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
    private static var plistPath: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.djtoolkit.agent.plist")
    }

    init() {
        Task { await refreshStatus() }
    }

    deinit {
        stopPolling()
    }

    func startPolling() {
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { await self.refreshStatus() }
        }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    @MainActor
    func refreshStatus() {
        let newStatus = Self.computeStatus()
        status = newStatus
    }

    private static func computeStatus() -> AgentStatus {
        guard FileManager.default.fileExists(atPath: plistPath.path) else {
            return .notInstalled
        }

        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["list", label]
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return .notInstalled
        }

        if process.terminationStatus != 0 {
            return .stopped
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        // PID column is "-" when the service is loaded but not running
        if output.contains("\t-\t") {
            return .stopped
        }
        return .running
    }
}
