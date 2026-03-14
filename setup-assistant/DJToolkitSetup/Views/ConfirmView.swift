import SwiftUI

struct ConfirmView: View {
    @Environment(SetupState.self) private var state
    @State private var showAdvanced = false
    @State private var isInstalling = false
    @State private var installProgress: String = ""

    var body: some View {
        @Bindable var state = state

        VStack(spacing: 20) {
            Text("Ready to install")
                .font(.title2)
                .fontWeight(.semibold)

            // Summary card
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    LabeledContent("Account", value: state.userEmail)
                    LabeledContent("Soulseek", value: state.slskUsername)
                    LabeledContent("AcoustID", value: state.acoustidKey.isEmpty ? "Skipped" : "Configured")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: 360)

            // Advanced settings
            DisclosureGroup("Advanced Settings", isExpanded: $showAdvanced) {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Downloads directory")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        HStack {
                            TextField("Path", text: $state.downloadsDir)
                                .textFieldStyle(.roundedBorder)
                            Button("Browse...") {
                                let panel = NSOpenPanel()
                                panel.canChooseDirectories = true
                                panel.canChooseFiles = false
                                panel.canCreateDirectories = true
                                if panel.runModal() == .OK, let url = panel.url {
                                    state.downloadsDir = url.path
                                }
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Poll interval: \(state.pollInterval) seconds")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        Slider(value: Binding(
                            get: { Double(state.pollInterval) },
                            set: { state.pollInterval = Int($0) }
                        ), in: 10...120, step: 5)
                    }
                }
                .padding(.top, 8)
            }
            .frame(maxWidth: 360)

            if isInstalling {
                VStack(spacing: 8) {
                    ProgressView()
                    Text(installProgress)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }

            if let error = state.errorMessage {
                Text(error)
                    .foregroundStyle(.red)
                    .font(.callout)
                    .frame(maxWidth: 360)
            }

            Spacer()

            HStack {
                Button("Back") { state.goBack() }
                    .buttonStyle(.bordered)
                    .disabled(isInstalling)
                Spacer()
                Button("Install & Start Agent") {
                    Task { await performInstall() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(isInstalling)
            }
        }
        .padding(40)
    }

    private func performInstall() async {
        isInstalling = true
        state.errorMessage = nil

        do {
            // 1. Configure
            installProgress = "Storing credentials..."
            let result = try await CLIBridge.configureHeadless(
                apiKey: state.apiKey,
                slskUser: state.slskUsername,
                slskPass: state.slskPassword,
                acoustidKey: state.acoustidKey.isEmpty ? nil : state.acoustidKey,
                cloudURL: state.cloudURL,
                downloadsDir: state.downloadsDir,
                pollInterval: state.pollInterval
            )
            state.resolvedDownloadsDir = result.downloads_dir ?? state.downloadsDir

            // 2. Install
            installProgress = "Installing agent..."
            try await CLIBridge.installAgent()

            state.advance()
        } catch {
            state.errorMessage = error.localizedDescription
        }

        isInstalling = false
    }
}
