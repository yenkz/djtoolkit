import Foundation

enum CLIBridgeError: LocalizedError {
    case binaryNotFound
    case executionFailed(String)
    case invalidOutput(String)

    var errorDescription: String? {
        switch self {
        case .binaryNotFound:
            return "djtoolkit CLI not found. Install with: brew install djtoolkit"
        case .executionFailed(let msg):
            return "CLI command failed: \(msg)"
        case .invalidOutput(let msg):
            return "Unexpected CLI output: \(msg)"
        }
    }
}

struct CLIResult: Decodable {
    let status: String
    let message: String?
    let config_path: String?
    let downloads_dir: String?
}

enum CLIBridge {
    /// Locate the djtoolkit binary on disk.
    static func findBinary() -> URL? {
        let candidates = [
            "/opt/homebrew/bin/djtoolkit",
            "/usr/local/bin/djtoolkit",
        ]
        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }
        // Fallback: which djtoolkit
        let whichProcess = Process()
        let whichPipe = Pipe()
        whichProcess.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        whichProcess.arguments = ["djtoolkit"]
        whichProcess.standardOutput = whichPipe
        whichProcess.standardError = FileHandle.nullDevice
        try? whichProcess.run()
        whichProcess.waitUntilExit()
        if whichProcess.terminationStatus == 0 {
            let data = whichPipe.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let path, !path.isEmpty {
                return URL(fileURLWithPath: path)
            }
        }
        return nil
    }

    /// Run a CLI command with optional stdin data. Returns stdout.
    static func run(_ arguments: [String], stdin: String? = nil) async throws -> String {
        guard let binary = findBinary() else {
            throw CLIBridgeError.binaryNotFound
        }

        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()

        process.executableURL = binary
        process.arguments = arguments
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        if let stdin {
            let stdinPipe = Pipe()
            process.standardInput = stdinPipe
            let inputData = Data(stdin.utf8)
            stdinPipe.fileHandleForWriting.write(inputData)
            stdinPipe.fileHandleForWriting.closeFile()
        }

        try process.run()
        process.waitUntilExit()

        let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
        let stderr = String(data: stderrData, encoding: .utf8) ?? ""

        if process.terminationStatus != 0 {
            if let data = stdout.data(using: .utf8),
               let result = try? JSONDecoder().decode(CLIResult.self, from: data) {
                throw CLIBridgeError.executionFailed(result.message ?? "Unknown error")
            }
            throw CLIBridgeError.executionFailed(stderr.isEmpty ? stdout : stderr)
        }

        return stdout
    }

    /// Run configure-headless with credentials piped via stdin.
    static func configureHeadless(
        apiKey: String,
        slskUser: String,
        slskPass: String,
        acoustidKey: String?,
        cloudURL: String,
        downloadsDir: String,
        pollInterval: Int
    ) async throws -> CLIResult {
        var payload: [String: Any] = [
            "api_key": apiKey,
            "slsk_user": slskUser,
            "slsk_pass": slskPass,
            "cloud_url": cloudURL,
            "downloads_dir": downloadsDir,
            "poll_interval": pollInterval,
        ]
        if let acoustidKey, !acoustidKey.isEmpty {
            payload["acoustid_key"] = acoustidKey
        } else {
            payload["acoustid_key"] = NSNull()
        }

        let jsonData = try JSONSerialization.data(withJSONObject: payload)
        let jsonString = String(data: jsonData, encoding: .utf8)!

        let stdout = try await run(
            ["agent", "configure-headless", "--stdin"],
            stdin: jsonString
        )

        guard let data = stdout.data(using: .utf8),
              let result = try? JSONDecoder().decode(CLIResult.self, from: data) else {
            throw CLIBridgeError.invalidOutput(stdout)
        }

        return result
    }

    /// Run agent install.
    static func installAgent() async throws {
        _ = try await run(["agent", "install"])
    }

    /// Install CLI binary from DMG to /usr/local/bin (prompts for admin password).
    /// Returns true if installed, false if already exists or user cancelled.
    static func installBinaryFromDMG() throws -> Bool {
        // Already installed?
        if findBinary() != nil { return true }

        // Look for binary on the same DMG volume as this app
        let appBundle = Bundle.main.bundlePath
        let dmgVolume = (appBundle as NSString).deletingLastPathComponent
        let dmgBinary = (dmgVolume as NSString).appendingPathComponent("djtoolkit")

        guard FileManager.default.fileExists(atPath: dmgBinary) else {
            throw CLIBridgeError.binaryNotFound
        }

        var error: NSDictionary?
        let script = "do shell script \"cp '\(dmgBinary)' /usr/local/bin/djtoolkit && chmod +x /usr/local/bin/djtoolkit\" with administrator privileges"
        guard let appleScript = NSAppleScript(source: script) else {
            throw CLIBridgeError.executionFailed("Failed to create install script")
        }
        appleScript.executeAndReturnError(&error)
        if let error {
            let msg = error[NSAppleScript.errorMessage] as? String ?? "User cancelled"
            throw CLIBridgeError.executionFailed(msg)
        }
        return true
    }
}
