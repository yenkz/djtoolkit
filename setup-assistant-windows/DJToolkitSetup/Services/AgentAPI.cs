using System;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;

namespace DJToolkitSetup.Services;

public record AgentRegistration(
    [property: JsonPropertyName("api_key")] string ApiKey,
    [property: JsonPropertyName("agent_id")] string AgentId
);

public static class AgentAPI
{
    private static readonly HttpClient _http = new();

    public static async Task<AgentRegistration> RegisterAsync(string cloudUrl, string jwt, string machineName)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"{cloudUrl}/api/agents/register")
        {
            Content = JsonContent.Create(new { machine_name = machineName }),
        };
        request.Headers.Authorization = new("Bearer", jwt);

        var response = await _http.SendAsync(request);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadFromJsonAsync<AgentRegistration>()
            ?? throw new Exception("Empty registration response");
    }
}
