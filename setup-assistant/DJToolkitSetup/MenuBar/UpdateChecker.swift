import AppKit
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
