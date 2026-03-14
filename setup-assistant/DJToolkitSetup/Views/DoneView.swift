import SwiftUI

struct DoneView: View {
    @Environment(SetupState.self) private var state

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
    }
}
