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

        // First-run: if no config exists, auto-launch wizard
        let configPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".djtoolkit/config.toml")
        if !FileManager.default.fileExists(atPath: configPath.path) {
            // Launch wizard (same as Re-run Setup)
            NSWorkspace.shared.openApplication(
                at: Bundle.main.bundleURL,
                configuration: NSWorkspace.OpenConfiguration()
            ) { _, _ in }
        }
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
