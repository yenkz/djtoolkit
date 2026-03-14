import SwiftUI

struct AcoustIDView: View {
    @Environment(SetupState.self) private var state

    var body: some View {
        @Bindable var state = state

        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "waveform.badge.magnifyingglass")
                .font(.system(size: 40))
                .foregroundColor(.accentColor)

            Text("Audio Fingerprinting (Optional)")
                .font(.title2)
                .fontWeight(.semibold)

            Text("AcoustID identifies tracks by their audio fingerprint to prevent duplicates and match metadata. You can add this later.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)

            TextField("AcoustID API Key", text: $state.acoustidKey)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 300)

            Link("Get a free key at acoustid.org",
                 destination: URL(string: "https://acoustid.org/api-key")!)
                .font(.callout)

            Spacer()

            HStack {
                Button("Back") { state.goBack() }
                    .buttonStyle(.bordered)
                Spacer()
                Button("Skip") { state.advance() }
                    .buttonStyle(.bordered)
                Button("Continue") { state.advance() }
                    .buttonStyle(.borderedProminent)
                    .disabled(state.acoustidKey.isEmpty)
            }
        }
        .padding(40)
    }
}
