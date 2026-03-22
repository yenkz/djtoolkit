import SwiftUI

struct ReconfigureView: View {
    @State private var downloadsDir: String = ""
    @State private var soulseekUsername: String = ""
    @State private var soulseekPassword: String = ""
    @State private var showSaved = false
    @State private var errorMessage: String?
    @Environment(\.dismiss) private var dismiss

    private let agentRunning: Bool

    init(agentRunning: Bool) {
        self.agentRunning = agentRunning
    }

    var body: some View {
        Form {
            Section("Downloads") {
                HStack {
                    TextField("Downloads Directory", text: $downloadsDir)
                        .textFieldStyle(.roundedBorder)
                    Button("Browse...") { pickFolder() }
                }
            }

            Section("Soulseek") {
                TextField("Username", text: $soulseekUsername)
                    .textFieldStyle(.roundedBorder)
                SecureField("Password", text: $soulseekPassword)
                    .textFieldStyle(.roundedBorder)
            }

            if let errorMessage {
                Text(errorMessage)
                    .foregroundStyle(.red)
                    .font(.caption)
            }

            if showSaved {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text("Saved")
                    if agentRunning {
                        Text("— restart the agent for changes to take effect.")
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save") { save() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.top, 8)
        }
        .padding(20)
        .frame(width: 400, height: 280)
        .onAppear { loadConfig() }
    }

    private func loadConfig() {
        let config = ConfigWriter.readConfig()
        downloadsDir = config.downloadsDir
        soulseekUsername = config.soulseekUsername
        soulseekPassword = config.soulseekPassword
    }

    private func save() {
        let config = ConfigWriter.Config(
            downloadsDir: downloadsDir,
            soulseekUsername: soulseekUsername,
            soulseekPassword: soulseekPassword
        )
        do {
            try ConfigWriter.writeConfig(config)
            errorMessage = nil
            showSaved = true
            // Auto-dismiss after 2s
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                showSaved = false
            }
        } catch {
            errorMessage = "Failed to save: \(error.localizedDescription)"
        }
    }

    private func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Select Downloads Folder"
        if panel.runModal() == .OK, let url = panel.url {
            downloadsDir = url.path
        }
    }
}
