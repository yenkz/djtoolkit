import Foundation

struct RecentJob: Identifiable {
    let id = UUID()
    let title: String
    let artist: String
    let jobType: String
    let status: String // "success", "failed", or "in_progress"
    let completedAt: Date

    var relativeTime: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: completedAt, relativeTo: Date())
    }
}

enum StatusReader {
    private static var statusPath: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".djtoolkit/agent-status.json")
    }

    /// Read the last 10 recent jobs from agent-status.json. Returns empty array if unavailable.
    static func recentJobs() -> [RecentJob] {
        guard let data = try? Data(contentsOf: statusPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let jobs = json["recent_jobs"] as? [[String: Any]] else {
            return []
        }

        return jobs.suffix(10).compactMap { job in
            guard let title = job["title"] as? String,
                  let artist = job["artist"] as? String,
                  let jobType = job["job_type"] as? String,
                  let status = job["status"] as? String,
                  let timestamp = job["completed_at"] as? Double else {
                return nil
            }
            return RecentJob(
                title: title,
                artist: artist,
                jobType: jobType,
                status: status,
                completedAt: Date(timeIntervalSince1970: timestamp)
            )
        }
    }
}
