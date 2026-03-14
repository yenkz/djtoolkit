import SwiftUI

struct SoulseekView: View {
    @Environment(SetupState.self) private var state

    var body: some View {
        @Bindable var state = state

        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "network")
                .font(.system(size: 40))
                .foregroundColor(.accentColor)

            Text("Connect to Soulseek")
                .font(.title2)
                .fontWeight(.semibold)

            Text("djtoolkit uses Soulseek to find and download music. Enter your Soulseek account credentials.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)

            VStack(alignment: .leading, spacing: 12) {
                TextField("Username", text: $state.slskUsername)
                    .textFieldStyle(.roundedBorder)
                SecureField("Password", text: $state.slskPassword)
                    .textFieldStyle(.roundedBorder)
            }
            .frame(maxWidth: 300)

            Link("Don't have an account? Create one at soulseek.org",
                 destination: URL(string: "https://www.slsknet.org/news/node/1")!)
                .font(.callout)

            Spacer()

            HStack {
                Button("Back") { state.goBack() }
                    .buttonStyle(.bordered)
                Spacer()
                Button("Continue") { state.advance() }
                    .buttonStyle(.borderedProminent)
                    .disabled(state.slskUsername.isEmpty || state.slskPassword.isEmpty)
            }
        }
        .padding(40)
    }
}
