import Foundation

enum JobStatus: String {
    case success
    case failed
    case inProgress = "in_progress"
}

struct RecentJob: Identifiable {
    let id = UUID()
    let title: String
    let artist: String
    let jobType: String
    let status: JobStatus
    let completedAt: Date

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    var relativeTime: String {
        Self.relativeFormatter.localizedString(for: completedAt, relativeTo: Date())
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
                  let statusStr = job["status"] as? String,
                  let status = JobStatus(rawValue: statusStr),
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
