import Foundation

enum AgentAPIError: LocalizedError {
    case registrationFailed(String)
    case networkError(String)

    var errorDescription: String? {
        switch self {
        case .registrationFailed(let msg): return "Agent registration failed: \(msg)"
        case .networkError(let msg): return "Network error: \(msg)"
        }
    }
}

struct AgentRegisterResponse: Decodable {
    let agent_id: String
    let api_key: String
    let message: String?
}

struct AgentAPI {
    let cloudURL: String

    /// Register a new agent using the JWT from OAuth.
    func registerAgent(jwt: String, machineName: String) async throws -> AgentRegisterResponse {
        guard let url = URL(string: "\(cloudURL)/api/agents/register") else {
            throw AgentAPIError.networkError("Invalid cloud URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = ["machine_name": machineName]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw AgentAPIError.networkError("Invalid response")
        }

        switch httpResponse.statusCode {
        case 201:
            return try JSONDecoder().decode(AgentRegisterResponse.self, from: data)
        case 401:
            throw AgentAPIError.registrationFailed("Authentication expired. Please sign in again.")
        case 429:
            throw AgentAPIError.registrationFailed("Too many registration attempts. Please wait and try again.")
        default:
            let body = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw AgentAPIError.registrationFailed("Server returned \(httpResponse.statusCode): \(body)")
        }
    }
}
