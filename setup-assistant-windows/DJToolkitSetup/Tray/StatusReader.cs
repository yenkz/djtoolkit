using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace DJToolkitSetup.Tray;

public record RecentJob(string Title, string Artist, string JobType, string Status, DateTime CompletedAt);

public static class StatusReader
{
    private static readonly string StatusPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "djtoolkit", "agent-status.json");

    public static List<RecentJob> ReadRecentJobs()
    {
        var jobs = new List<RecentJob>();

        try
        {
            if (!File.Exists(StatusPath)) return jobs;

            var json = File.ReadAllText(StatusPath);
            using var doc = JsonDocument.Parse(json);

            if (!doc.RootElement.TryGetProperty("recent_jobs", out var arr)
                || arr.ValueKind != JsonValueKind.Array)
                return jobs;

            foreach (var item in arr.EnumerateArray())
            {
                var title = item.TryGetProperty("title", out var t) ? t.GetString() ?? "Unknown" : "Unknown";
                var artist = item.TryGetProperty("artist", out var a) ? a.GetString() ?? "Unknown" : "Unknown";
                var jobType = item.TryGetProperty("job_type", out var jt) ? jt.GetString() ?? "" : "";
                var status = item.TryGetProperty("status", out var s) ? s.GetString() ?? "" : "";
                var completedAt = DateTime.UnixEpoch;
                if (item.TryGetProperty("completed_at", out var ca) && ca.ValueKind == JsonValueKind.Number)
                    completedAt = DateTime.UnixEpoch.AddSeconds(ca.GetDouble()).ToLocalTime();

                jobs.Add(new RecentJob(title, artist, jobType, status, completedAt));
            }
        }
        catch { /* return empty list on any error */ }

        return jobs;
    }

    public static string? ReadState()
    {
        try
        {
            if (!File.Exists(StatusPath)) return null;
            var json = File.ReadAllText(StatusPath);
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.TryGetProperty("state", out var s) ? s.GetString() : null;
        }
        catch { return null; }
    }
}
