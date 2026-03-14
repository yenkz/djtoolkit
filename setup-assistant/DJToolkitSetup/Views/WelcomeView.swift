import SwiftUI

struct WelcomeView: View {
    @Environment(SetupState.self) private var state

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "music.note.house.fill")
                .font(.system(size: 64))
                .foregroundStyle(.accent)

            Text("Set up djtoolkit on this Mac")
                .font(.title)
                .fontWeight(.semibold)

            Text("djtoolkit downloads, fingerprints, and tags your DJ music library. This wizard will connect your Mac to your djtoolkit account.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)

            // Pre-existing state warnings
            if state.agentRunning {
                GroupBox {
                    Label("djtoolkit agent is already running on this Mac.", systemImage: "checkmark.circle")
                        .foregroundStyle(.green)
                    Text("You can reconfigure it or close this wizard.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: 360)
            } else if state.alreadyConfigured {
                GroupBox {
                    Label("A previous configuration was found.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                    Text("Continuing will overwrite the existing configuration.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: 360)
            }

            Spacer()

            HStack {
                if state.agentRunning {
                    Button("Close") { NSApp.terminate(nil) }
                        .buttonStyle(.bordered)
                    Spacer()
                }
                Button(state.agentRunning ? "Reconfigure" : "Get Started") {
                    state.advance()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }

            Spacer().frame(height: 20)
        }
        .padding(40)
    }
}
