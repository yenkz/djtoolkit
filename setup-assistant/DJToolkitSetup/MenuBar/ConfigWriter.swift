import Foundation

enum ConfigWriter {
    private static var configPath: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".djtoolkit/config.toml")
    }

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
