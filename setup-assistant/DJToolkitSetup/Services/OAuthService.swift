import AuthenticationServices
import Foundation

class OAuthService: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? ASPresentationAnchor()
    }

    /// Start OAuth flow. Returns the access token (JWT) from the callback URL.
    func signIn(supabaseURL: String) async throws -> (jwt: String, email: String?) {
        let authURL = URL(string: "\(supabaseURL)/auth/v1/authorize?provider=google&redirect_to=djtoolkit://auth/callback")!
        let callbackScheme = "djtoolkit"

        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authURL,
                callbackURLScheme: callbackScheme
            ) { callbackURL, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let callbackURL else {
                    continuation.resume(throwing: OAuthError.noCallback)
                    return
                }

                guard let fragment = callbackURL.fragment else {
                    continuation.resume(throwing: OAuthError.missingToken)
                    return
                }

                let params = fragment
                    .split(separator: "&")
                    .reduce(into: [String: String]()) { dict, pair in
                        let parts = pair.split(separator: "=", maxSplits: 1)
                        if parts.count == 2 {
                            dict[String(parts[0])] = String(parts[1])
                        }
                    }

                guard let accessToken = params["access_token"] else {
                    continuation.resume(throwing: OAuthError.missingToken)
                    return
                }

                let email = Self.extractEmail(from: accessToken)
                continuation.resume(returning: (jwt: accessToken, email: email))
            }

            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            session.start()
        }
    }

    /// Extract email from JWT payload without verification (display only).
    private static func extractEmail(from jwt: String) -> String? {
        let segments = jwt.split(separator: ".")
        guard segments.count == 3 else { return nil }
        var base64 = String(segments[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64.append("=") }
        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json["email"] as? String
    }
}

enum OAuthError: LocalizedError {
    case noCallback
    case missingToken
    case missingSupabaseURL

    var errorDescription: String? {
        switch self {
        case .noCallback: return "Sign-in was cancelled."
        case .missingToken: return "No access token received. Please try again."
        case .missingSupabaseURL: return "Supabase URL not configured. This build is missing the SupabaseURL setting — please reinstall from a release build."
        }
    }
}
