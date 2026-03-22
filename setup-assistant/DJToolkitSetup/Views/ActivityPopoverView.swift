import SwiftUI

struct ActivityPopoverView: View {
    let jobs: [RecentJob]

    var body: some View {
        VStack(spacing: 0) {
            Text("Recent Activity")
                .font(.headline)
                .padding(.top, 12)
                .padding(.bottom, 8)

            Divider()

            if jobs.isEmpty {
                Spacer()
                Text("No activity yet.")
                    .foregroundStyle(.secondary)
                    .font(.body)
                Spacer()
            } else {
                List(jobs) { job in
                    HStack(spacing: 10) {
                        // Status icon
                        if job.status == "in_progress" {
                            ProgressView()
                                .controlSize(.small)
                                .frame(width: 20, height: 20)
                        } else {
                            Image(systemName: job.status == "success"
                                  ? "checkmark.circle.fill"
                                  : "xmark.circle.fill")
                                .foregroundStyle(job.status == "success" ? .green : .red)
                                .font(.title3)
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            Text(jobDescription(job))
                                .font(.callout)
                                .lineLimit(1)
                            Text("\(job.artist) \u{2014} \(job.relativeTime)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .listStyle(.plain)
            }
        }
        .frame(width: 320, height: 380)
    }

    private func jobDescription(_ job: RecentJob) -> String {
        switch job.jobType {
        case "download": return "Downloaded '\(job.title)'"
        case "fingerprint": return "Fingerprinted '\(job.title)'"
        case "cover_art": return "Cover art for '\(job.title)'"
        case "metadata": return "Tagged '\(job.title)'"
        case "audio_analysis": return "Analyzed '\(job.title)'"
        default: return "\(job.jobType): '\(job.title)'"
        }
    }
}
