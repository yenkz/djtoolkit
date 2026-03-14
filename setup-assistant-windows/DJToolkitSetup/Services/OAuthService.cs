using System;
using System.Web;

namespace DJToolkitSetup.Services;

public record OAuthResult(string AccessToken, string Email);

public class OAuthService
{
    private readonly string _supabaseUrl;

    public OAuthService(string supabaseUrl)
    {
        _supabaseUrl = supabaseUrl;
    }

    public string GetAuthUrl()
    {
        return $"{_supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=djtoolkit://auth/callback";
    }

    public static OAuthResult? ParseCallback(string uri)
    {
        if (!uri.StartsWith("djtoolkit://auth/callback")) return null;

        var fragment = new Uri(uri).Fragment.TrimStart('#');
        var query = HttpUtility.ParseQueryString(fragment);

        var token = query["access_token"];
        if (string.IsNullOrEmpty(token)) return null;

        var parts = token.Split('.');
        if (parts.Length >= 2)
        {
            var payload = parts[1];
            payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
            var json = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(payload));
            var doc = System.Text.Json.JsonDocument.Parse(json);
            var email = doc.RootElement.TryGetProperty("email", out var e) ? e.GetString() ?? "" : "";
            return new OAuthResult(token, email);
        }

        return new OAuthResult(token, "");
    }
}
