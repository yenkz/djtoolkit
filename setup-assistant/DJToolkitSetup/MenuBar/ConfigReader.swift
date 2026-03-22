import Foundation

enum ConfigReader {
    private static var configDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".djtoolkit")
    }
    private static var configPath: URL {
        configDir.appendingPathComponent("config.toml")
    }
    private static var defaultDownloadsDir: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Music/djtoolkit/downloads").path
    }

    static var logFilePath: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/djtoolkit/agent.log").path
    }

    /// Read downloads_dir from config.toml. Falls back to ~/Music/djtoolkit/downloads.
    static var downloadsDir: String {
        guard let contents = try? String(contentsOf: configPath, encoding: .utf8) else {
            return defaultDownloadsDir
        }

        // Simple line-by-line TOML parsing — find downloads_dir in [agent] section
        var inAgentSection = false
        for line in contents.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("[") {
                inAgentSection = trimmed == "[agent]"
                continue
            }
            guard inAgentSection else { continue }
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
                        value = (value as NSString).expandingTildeInPath
                    }
                    return value.isEmpty ? defaultDownloadsDir : value
                }
            }
        }

        return defaultDownloadsDir
    }
}
