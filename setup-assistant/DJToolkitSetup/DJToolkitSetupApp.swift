import SwiftUI

@main
struct DJToolkitSetupApp: App {
    @State private var state = SetupState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(state)
                .frame(width: 520, height: 480)
                .fixedSize()
                .task {
                    // Install CLI binary from DMG if not already installed
                    if CLIBridge.findBinary() == nil {
                        do {
                            _ = try CLIBridge.installBinaryFromDMG()
                        } catch {
                            state.errorMessage = error.localizedDescription
                        }
                    }
                }
        }
        .windowResizability(.contentSize)
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
