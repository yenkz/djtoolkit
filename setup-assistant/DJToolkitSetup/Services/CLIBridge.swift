import Foundation
import Security

enum CLIBridgeError: LocalizedError {
    case binaryNotFound
    case executionFailed(String)
    case invalidOutput(String)
    case keychainError(OSStatus)

    var errorDescription: String? {
        switch self {
        case .binaryNotFound:
            return "djtoolkit CLI not found. Install with: brew install djtoolkit"
        case .executionFailed(let msg):
            return "CLI command failed: \(msg)"
        case .invalidOutput(let msg):
            return "Unexpected CLI output: \(msg)"
        case .keychainError(let status):
            let msg = SecCopyErrorMessageString(status, nil) as String? ?? "Unknown"
            return "Keychain error: \(msg)"
        }
    }
}

struct CLIResult {
    let status: String
    let message: String?
    let config_path: String?
    let downloads_dir: String?
}

enum CLIBridge {
    // MARK: - Keychain

    private static let keychainService = "djtoolkit"

    private static func setKeychainPassword(account: String, password: String) throws {
        let data = Data(password.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
        ]

        // Try adding first
        var addQuery = query
        addQuery[kSecValueData as String] = data
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)

        if addStatus == errSecDuplicateItem {
            // Item exists (possibly from Python keyring) — update it instead
            let updateStatus = SecItemUpdate(
                query as CFDictionary,
                [kSecValueData as String: data] as CFDictionary
            )
            guard updateStatus == errSecSuccess else {
                throw CLIBridgeError.keychainError(updateStatus)
            }
        } else if addStatus != errSecSuccess {
            throw CLIBridgeError.keychainError(addStatus)
        }
    }

    private static func hasKeychainPassword(account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
            kSecReturnData as String: false,
        ]
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    // MARK: - Binary resolution

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

    // MARK: - Configure (native)

    /// Store credentials and write config file — no CLI binary needed.
    static func configureHeadless(
        apiKey: String,
        slskUser: String,
        slskPass: String,
        acoustidKey: String?,
        cloudURL: String,
        downloadsDir: String,
        pollInterval: Int
    ) async throws -> CLIResult {
        // 1. Store credentials in macOS Keychain
        try setKeychainPassword(account: "agent-api-key", password: apiKey)
        try setKeychainPassword(account: "soulseek-username", password: slskUser)
        try setKeychainPassword(account: "soulseek-password", password: slskPass)
        if let acoustidKey, !acoustidKey.isEmpty {
            try setKeychainPassword(account: "acoustid-key", password: acoustidKey)
        }

        // 2. Write config file
        let home = FileManager.default.homeDirectoryForCurrentUser
        let configDir = home.appendingPathComponent(".djtoolkit")
        try FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)

        let configPath = configDir.appendingPathComponent("config.toml")

        // Expand ~ in downloads dir for the response
        let expandedDownloads: String
        if downloadsDir.hasPrefix("~") {
            expandedDownloads = home.path + downloadsDir.dropFirst()
        } else {
            expandedDownloads = downloadsDir
        }

        // TOML config matching Python agent's format
        let configContent = """
        [agent]
        cloud_url = "\(cloudURL)"
        poll_interval_sec = \(pollInterval)
        max_concurrent_jobs = 2
        downloads_dir = "\(downloadsDir)"

        [soulseek]
        search_timeout_sec = 15
        download_timeout_sec = 300

        [fingerprint]
        enabled = true

        [cover_art]
        sources = "coverart itunes deezer"
        """

        try configContent.write(to: configPath, atomically: true, encoding: .utf8)

        return CLIResult(
            status: "ok",
            message: nil,
            config_path: configPath.path,
            downloads_dir: expandedDownloads
        )
    }

    // MARK: - Agent install (native)

    private static let agentLabel = "com.djtoolkit.agent"

    /// Install LaunchAgent plist and load it — no CLI binary needed.
    static func installAgent() async throws {
        guard hasKeychainPassword(account: "agent-api-key") else {
            throw CLIBridgeError.executionFailed("Agent not configured. Missing API key in Keychain.")
        }

        guard let binary = findBinary() else {
            throw CLIBridgeError.binaryNotFound
        }

        let home = FileManager.default.homeDirectoryForCurrentUser
        let plistDir = home
            .appendingPathComponent("Library")
            .appendingPathComponent("LaunchAgents")
        let plistPath = plistDir.appendingPathComponent("\(agentLabel).plist")
        let logDir = home
            .appendingPathComponent("Library")
            .appendingPathComponent("Logs")
            .appendingPathComponent("djtoolkit")
        let logPath = logDir.appendingPathComponent("agent.log")

        // Create directories
        try FileManager.default.createDirectory(at: plistDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)

        // Resolve symlinks for the binary path in the plist
        let resolvedBinary = binary.resolvingSymlinksInPath().path

        let plistContent = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key>
            <string>\(agentLabel)</string>
            <key>ProgramArguments</key>
            <array>
                <string>\(resolvedBinary)</string>
                <string>agent</string>
                <string>run</string>
            </array>
            <key>KeepAlive</key>
            <true/>
            <key>RunAtLoad</key>
            <true/>
            <key>StandardOutPath</key>
            <string>\(logPath.path)</string>
            <key>StandardErrorPath</key>
            <string>\(logPath.path)</string>
            <key>ThrottleInterval</key>
            <integer>10</integer>
            <key>SoftResourceLimits</key>
            <dict>
                <key>NumberOfFiles</key>
                <integer>8192</integer>
            </dict>
            <key>HardResourceLimits</key>
            <dict>
                <key>NumberOfFiles</key>
                <integer>8192</integer>
            </dict>
            <key>EnvironmentVariables</key>
            <dict>
                <key>HOME</key>
                <string>\(home.path)</string>
            </dict>
        </dict>
        </plist>
        """

        try plistContent.write(to: plistPath, atomically: true, encoding: .utf8)

        // Load via launchctl
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["load", plistPath.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()

        if process.terminationStatus != 0 {
            let stderrData = (process.standardError as! Pipe).fileHandleForReading.readDataToEndOfFile()
            let stderr = String(data: stderrData, encoding: .utf8) ?? ""
            throw CLIBridgeError.executionFailed("launchctl load failed: \(stderr)")
        }
    }

    // MARK: - DMG install

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
