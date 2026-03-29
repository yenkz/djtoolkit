// web/components/folder-import/FolderImportReport.tsx
"use client";

import { useEffect, useState } from "react";
import { getFolderImportReport, type FolderImportReport } from "@/lib/api";

const FIELD_LABELS: Record<string, string> = {
  artist: "Artist",
  title: "Title",
  album: "Album",
  tempo: "BPM",
  key: "Key",
  genres: "Genres",
  cover_art_written: "Cover Art",
};

const TRACKED_FIELDS = [
  "artist",
  "title",
  "album",
  "tempo",
  "key",
  "genres",
  "cover_art_written",
];

function getFilename(path: string) {
  return path.split("/").pop() ?? path;
}

export function FolderImportReport({ jobId }: { jobId: string }) {
  const [report, setReport] = useState<FolderImportReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getFolderImportReport(jobId)
      .then(setReport)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [jobId]);

  if (loading) {
    return (
      <div
        className="font-mono"
        style={{
          padding: "32px",
          textAlign: "center",
          color: "var(--hw-text-muted)",
          fontSize: 11,
          letterSpacing: 2,
          textTransform: "uppercase",
        }}
      >
        Loading report...
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="font-mono"
        style={{
          padding: "32px",
          textAlign: "center",
          color: "#CC4444",
          fontSize: 11,
          letterSpacing: 1.5,
          textTransform: "uppercase",
        }}
      >
        Error: {error}
      </div>
    );
  }

  if (!report) return null;

  const incomplete = report.tracks.filter(
    (t) => t.acquisition_status !== "failed" && t.missing_fields.length > 0,
  ).length;

  const failed = report.tracks.filter(
    (t) => t.acquisition_status === "failed",
  ).length;

  const lcdItems = [
    { label: "Imported", value: report.total, color: "var(--hw-lcd-text)" },
    {
      label: "Fully Enriched",
      value: report.fully_enriched,
      color: "var(--led-green-on)",
    },
    {
      label: "Incomplete",
      value: incomplete,
      color: incomplete > 0 ? "var(--led-orange-on)" : "var(--hw-lcd-text)",
    },
    {
      label: "Failed",
      value: failed,
      color: "var(--hw-text-dim)",
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* LCD Summary */}
      <div
        style={{
          background: "var(--hw-lcd-bg)",
          border: "1px solid var(--hw-lcd-border)",
          borderRadius: 6,
          padding: "14px 20px",
          display: "flex",
          gap: 0,
        }}
      >
        {lcdItems.map((item, i, arr) => (
          <div
            key={item.label}
            style={{
              flex: 1,
              textAlign: "center",
              borderRight:
                i < arr.length - 1
                  ? "1px solid var(--hw-lcd-border)"
                  : undefined,
              padding: "0 16px",
            }}
          >
            <div
              className="font-mono"
              style={{
                fontSize: 26,
                fontWeight: 700,
                letterSpacing: 2,
                color: item.color,
                lineHeight: 1.1,
              }}
            >
              {item.value}
            </div>
            <div
              className="font-mono"
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: 2,
                textTransform: "uppercase",
                color: item.color,
                marginTop: 4,
                opacity: 0.7,
              }}
            >
              {item.label}
            </div>
          </div>
        ))}
      </div>

      {/* Field Completeness */}
      <div
        style={{
          background: "var(--hw-surface)",
          border: "1px solid var(--hw-border-light)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid var(--hw-border)",
          }}
        >
          <span
            className="font-mono"
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: "var(--hw-text-muted)",
            }}
          >
            Field Completeness
          </span>
        </div>
        <div
          style={{
            padding: "12px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {TRACKED_FIELDS.map((field) => {
            const missingCount = report.missing[field] ?? 0;
            const presentCount = report.total - missingCount;
            const pct = report.total > 0 ? presentCount / report.total : 0;
            const isGood = pct >= 0.8;
            const barColor = isGood ? "var(--led-green-on)" : "var(--led-orange-on)";
            const barBg = isGood
              ? "rgba(68,255,68,0.08)"
              : "rgba(255,170,0,0.08)";

            return (
              <div
                key={field}
                style={{
                  display: "grid",
                  gridTemplateColumns: "80px 1fr 64px",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <span
                  className="font-mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 1,
                    color: "var(--hw-text-secondary)",
                    textAlign: "right",
                  }}
                >
                  {FIELD_LABELS[field]}
                </span>
                <div
                  style={{
                    height: 8,
                    borderRadius: 4,
                    background: "var(--hw-border-light)",
                    overflow: "hidden",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${pct * 100}%`,
                      borderRadius: 4,
                      background: barColor,
                      boxShadow: `0 0 6px ${barColor}`,
                      transition: "width 0.4s ease",
                    }}
                  />
                  {/* subtle tinted track bg */}
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: barBg,
                      borderRadius: 4,
                      pointerEvents: "none",
                    }}
                  />
                </div>
                <span
                  className="font-mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.5,
                    color: isGood ? "var(--led-green-on)" : "var(--led-orange-on)",
                    textAlign: "right",
                    whiteSpace: "nowrap",
                  }}
                >
                  {presentCount}/{report.total}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-Track Detail Table */}
      <div
        style={{
          background: "var(--hw-surface)",
          border: "1px solid var(--hw-border-light)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid var(--hw-border)",
          }}
        >
          <span
            className="font-mono"
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: "var(--hw-text-muted)",
            }}
          >
            Per-Track Detail
          </span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 11,
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--hw-border)",
                  background: "rgba(255,255,255,0.02)",
                }}
              >
                {[
                  "Track",
                  "Artist",
                  "Album",
                  "BPM",
                  "Key",
                  "Genres",
                  "Art",
                  "Renamed To",
                ].map((col) => (
                  <th
                    key={col}
                    className="font-mono"
                    style={{
                      padding: "8px 12px",
                      textAlign: col === "Renamed To" ? "left" : "center",
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: 1.5,
                      textTransform: "uppercase",
                      color: "var(--hw-text-dim)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.tracks.map((track, idx) => {
                const isFailed = track.acquisition_status === "failed";
                const missing = new Set(track.missing_fields);

                const checkCell = (field: string) => {
                  const absent = missing.has(field);
                  return (
                    <td
                      key={field}
                      style={{
                        padding: "8px 12px",
                        textAlign: "center",
                        borderBottom:
                          idx < report.tracks.length - 1
                            ? "1px solid var(--hw-border)"
                            : undefined,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 13,
                          color: absent ? "#CC4444" : "var(--led-green-on)",
                        }}
                      >
                        {absent ? "✗" : "✓"}
                      </span>
                    </td>
                  );
                };

                return (
                  <tr
                    key={track.id}
                    style={{
                      opacity: isFailed ? 0.45 : 1,
                      background:
                        idx % 2 === 0
                          ? "transparent"
                          : "rgba(255,255,255,0.015)",
                    }}
                  >
                    {/* Track title */}
                    <td
                      style={{
                        padding: "8px 12px",
                        borderBottom:
                          idx < report.tracks.length - 1
                            ? "1px solid var(--hw-border)"
                            : undefined,
                        maxWidth: 180,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: "var(--hw-text)",
                        }}
                      >
                        {track.title || (
                          <span style={{ color: "var(--hw-text-dim)" }}>—</span>
                        )}
                      </span>
                    </td>

                    {/* Field check cells */}
                    {checkCell("artist")}
                    {checkCell("album")}
                    {checkCell("tempo")}
                    {checkCell("key")}
                    {checkCell("genres")}
                    {checkCell("cover_art_written")}

                    {/* Renamed To */}
                    <td
                      style={{
                        padding: "8px 12px",
                        borderBottom:
                          idx < report.tracks.length - 1
                            ? "1px solid var(--hw-border)"
                            : undefined,
                        maxWidth: 220,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span
                        className="font-mono"
                        style={{
                          fontSize: 10,
                          color: "var(--hw-lcd-text)",
                          letterSpacing: 0.3,
                        }}
                      >
                        {track.local_path
                          ? getFilename(track.local_path)
                          : <span style={{ color: "var(--hw-text-dim)" }}>—</span>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
