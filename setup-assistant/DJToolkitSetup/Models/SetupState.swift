import Foundation
import Observation
import Network

enum SetupStep: Int, CaseIterable {
    case welcome, signIn, soulseek, acoustID, confirm, done
}

@Observable
class SetupState {
    // Navigation
    var currentStep: SetupStep = .welcome

    // Step 2: Sign In
    var jwt: String = ""
    var apiKey: String = ""
    var userEmail: String = ""

    // Step 3: Soulseek
    var slskUsername: String = ""
    var slskPassword: String = ""

    // Step 4: AcoustID
    var acoustidKey: String = ""

    // Step 5: Advanced Settings
    var downloadsDir: String = "~/Music/djtoolkit/downloads"
    var pollInterval: Int = 30
    var cloudURL: String = "https://api.djtoolkit.com"

    // Supabase URL for OAuth — derived from env or config, NOT hardcoded
    // Set via SUPABASE_URL environment variable or build-time config
    var supabaseURL: String = ProcessInfo.processInfo.environment["SUPABASE_URL"]
        ?? "https://CONFIGURE_ME.supabase.co"

    // Status
    var isLoading: Bool = false
    var errorMessage: String? = nil
    var isOnline: Bool = true

    // Pre-existing state detection
    var alreadyConfigured: Bool = false
    var agentRunning: Bool = false

    // Result (from configure-headless output)
    var resolvedDownloadsDir: String = ""

    // Network monitoring
    private let monitor = NWPathMonitor()

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                self?.isOnline = path.status == .satisfied
            }
        }
        monitor.start(queue: DispatchQueue(label: "NetworkMonitor"))

        // Detect pre-existing configuration
        let configPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".djtoolkit/config.toml")
        alreadyConfigured = FileManager.default.fileExists(atPath: configPath.path)

        // Check if agent is already running via launchctl
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["list", "com.djtoolkit.agent"]
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
        agentRunning = process.terminationStatus == 0
    }

    func advance() {
        guard let nextIndex = SetupStep(rawValue: currentStep.rawValue + 1) else { return }
        currentStep = nextIndex
    }

    func goBack() {
        guard let prevIndex = SetupStep(rawValue: currentStep.rawValue - 1) else { return }
        currentStep = prevIndex
    }
}
