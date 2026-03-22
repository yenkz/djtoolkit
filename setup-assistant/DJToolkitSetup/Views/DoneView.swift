import SwiftUI

struct DoneView: View {
    @Environment(SetupState.self) private var state
    @State private var trayStarted = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(.green)

            Text("djtoolkit is running")
                .font(.title)
                .fontWeight(.semibold)

            VStack(alignment: .leading, spacing: 8) {
                Label {
                    Text("Your music will download to:")
                        .foregroundStyle(.secondary)
                } icon: {
                    Image(systemName: "folder.fill")
                }
                Text(state.resolvedDownloadsDir)
                    .font(.system(.body, design: .monospaced))
                    .padding(.leading, 28)

                Label {
                    Text("Agent logs:")
                        .foregroundStyle(.secondary)
                } icon: {
                    Image(systemName: "doc.text.fill")
                }
                Text("~/Library/Logs/djtoolkit/agent.log")
                    .font(.system(.body, design: .monospaced))
                    .padding(.leading, 28)

                if trayStarted {
                    Label {
                        Text("Menu bar app started — look for the icon in your menu bar.")
                            .foregroundStyle(.secondary)
                    } icon: {
                        Image(systemName: "menubar.arrow.up.rectangle")
                    }
                }
            }
            .frame(maxWidth: 360, alignment: .leading)

            Spacer()

            HStack {
                Button("Open djtoolkit") {
                    if let url = URL(string: state.cloudURL) {
                        NSWorkspace.shared.open(url)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Button("Close") {
                    NSApp.terminate(nil)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }

            Spacer().frame(height: 20)
        }
        .padding(40)
        .onAppear { launchTrayMode() }
    }

    private func launchTrayMode() {
        // Enable login item so the tray app starts on boot
        try? LoginItemManager.enable()

        // Launch tray instance of this app with --tray flag
        let appURL = Bundle.main.bundleURL
        let config = NSWorkspace.OpenConfiguration()
        config.arguments = ["--tray"]
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: appURL, configuration: config) { _, error in
            DispatchQueue.main.async {
                trayStarted = error == nil
            }
        }
    }
}
