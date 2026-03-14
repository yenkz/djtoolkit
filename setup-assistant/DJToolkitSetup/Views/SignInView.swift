import SwiftUI

struct SignInView: View {
    @Environment(SetupState.self) private var state
    @State private var oauthService = OAuthService()
    @State private var isSigningIn = false
    @State private var signedIn = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Text("Sign in to your djtoolkit account")
                .font(.title2)
                .fontWeight(.semibold)

            if !state.isOnline {
                Label("No internet connection. Connect to the internet and try again.",
                      systemImage: "wifi.slash")
                    .foregroundStyle(.red)
                    .font(.callout)
            }

            if signedIn {
                VStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(.green)
                    Text("Signed in as \(state.userEmail)")
                        .font(.headline)
                    Text("Agent registered")
                        .foregroundStyle(.secondary)
                }
            } else if isSigningIn {
                ProgressView("Waiting for sign-in...")
            } else {
                Button("Sign In with Browser") {
                    Task { await performSignIn() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!state.isOnline)
            }

            if let error = state.errorMessage {
                Text(error)
                    .foregroundStyle(.red)
                    .font(.callout)

                Button("Try Again") {
                    state.errorMessage = nil
                }
                .buttonStyle(.bordered)
            }

            Spacer()

            HStack {
                Button("Back") { state.goBack() }
                    .buttonStyle(.bordered)
                Spacer()
                Button("Continue") { state.advance() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!signedIn)
            }
        }
        .padding(40)
    }

    private func performSignIn() async {
        isSigningIn = true
        state.errorMessage = nil

        do {
            // 1. OAuth — supabaseURL comes from SUPABASE_URL env var (set at build time)
            let (jwt, email) = try await oauthService.signIn(
                supabaseURL: state.supabaseURL
            )
            state.jwt = jwt
            state.userEmail = email ?? "unknown"

            // 2. Register agent
            let api = AgentAPI(cloudURL: state.cloudURL)
            let machineName = Host.current().localizedName ?? "My Mac"
            let response = try await api.registerAgent(jwt: jwt, machineName: machineName)
            state.apiKey = response.api_key

            signedIn = true
        } catch {
            state.errorMessage = error.localizedDescription
        }

        isSigningIn = false
    }
}
