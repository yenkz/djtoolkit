"use client";

import { useEffect, useState, useCallback } from "react";
import { type PipelineJob, type PipelineTrack, fetchTracksByIds } from "@/lib/api";

/* ── Status colors ─────────────────────────────────────────────────────── */

const JOB_STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  done: { color: "var(--led-green)", bg: "color-mix(in srgb, var(--led-green) 10%, transparent)" },
  failed: { color: "var(--led-red)", bg: "color-mix(in srgb, var(--led-red) 10%, transparent)" },
  pending: { color: "var(--led-blue)", bg: "color-mix(in srgb, var(--led-blue) 10%, transparent)" },
  claimed: { color: "var(--led-orange)", bg: "color-mix(in srgb, var(--led-orange) 10%, transparent)" },
  running: { color: "var(--led-blue)", bg: "color-mix(in srgb, var(--led-blue) 10%, transparent)" },
};

const JOB_LABELS: Record<string, string> = {
  download: "Download",
  fingerprint: "Fingerprint",
  spotify_lookup: "Spotify Lookup",
  cover_art: "Cover Art",
  audio_analysis: "Audio Analysis",
  metadata: "Metadata",
};

/* ── Helpers ────────────────────────────────────────────────────────────── */

function relativeTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function payloadSummary(job: PipelineJob): string | null {
  if (!job.payload) return null;
  const p = job.payload as Record<string, unknown>;
  if (job.job_type === "download" && p.search_string) return `"${p.search_string}"`;
  if (job.job_type === "metadata" && p.metadata_source) return `source: ${p.metadata_source}`;
  return null;
}

function resultSummary(job: PipelineJob): string | null {
  if (!job.result) return null;
  const r = job.result as Record<string, unknown>;
  if (job.job_type === "download" && r.local_path) {
    const path = String(r.local_path);
    return path.split("/").pop() ?? path;
  }
  if (job.job_type === "fingerprint") {
    return r.acoustid ? `AcoustID: ${r.acoustid}` : "No match";
  }
  if (job.job_type === "spotify_lookup") {
    return (r as Record<string, unknown>).matched === false ? "No match" : "Matched";
  }
  if (job.job_type === "cover_art") {
    return r.cover_art_written ? "Embedded" : "Not found";
  }
  if (job.job_type === "audio_analysis") {
    const parts: string[] = [];
    if (r.tempo) parts.push(`${Math.round(Number(r.tempo))} BPM`);
    if (r.key != null) parts.push(`key: ${r.key}`);
    if (r.loudness != null) parts.push(`${Number(r.loudness).toFixed(1)} LUFS`);
    return parts.join(", ") || null;
  }
  if (job.job_type === "metadata") {
    return r.metadata_written ? "Written" : "Skipped";
  }
  return null;
}

/* ── Track flags grid ──────────────────────────────────────────────────── */

interface TrackFlags {
  fingerprinted: boolean;
  enriched_spotify: boolean;
  enriched_audio: boolean;
  metadata_written: boolean;
  cover_art_written: boolean;
  in_library: boolean;
}

const FLAG_LABELS: { key: keyof TrackFlags; label: string }[] = [
  { key: "fingerprinted", label: "Fingerprinted" },
  { key: "enriched_spotify", label: "Spotify Enriched" },
  { key: "enriched_audio", label: "Audio Analyzed" },
  { key: "metadata_written", label: "Metadata Written" },
  { key: "cover_art_written", label: "Cover Art" },
  { key: "in_library", label: "In Library" },
];

function TrackFlagGrid({ flags }: { flags: TrackFlags | null }) {
  if (!flags) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
      {FLAG_LABELS.map(({ key, label }) => (
        <div key={key} className="flex items-center gap-2">
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: flags[key] ? "var(--led-green)" : "var(--hw-text-muted)",
              opacity: flags[key] ? 1 : 0.3,
            }}
          />
          <span
            className="font-mono"
            style={{ fontSize: 10, color: flags[key] ? "var(--hw-text)" : "var(--hw-text-muted)" }}
          >
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Job timeline entry ────────────────────────────────────────────────── */

function JobTimelineEntry({ job }: { job: PipelineJob }) {
  const colors = JOB_STATUS_COLORS[job.status] ?? JOB_STATUS_COLORS.pending;
  const label = JOB_LABELS[job.job_type] ?? job.job_type;
  const payload = payloadSummary(job);
  const result = resultSummary(job);

  return (
    <div
      style={{
        padding: "10px 12px",
        borderLeft: `3px solid ${colors.color}`,
        background: colors.bg,
        borderRadius: "0 4px 4px 0",
      }}
    >
      <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
        <span className="font-mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--hw-text)" }}>
          {label}
        </span>
        <span
          className="font-mono uppercase"
          style={{ fontSize: 9, fontWeight: 700, color: colors.color, letterSpacing: 0.5 }}
        >
          {job.status}
        </span>
        {job.retry_count > 0 && (
          <span className="font-mono" style={{ fontSize: 9, color: "var(--led-orange)" }}>
            retry {job.retry_count}/3
          </span>
        )}
      </div>

      <div className="font-mono" style={{ fontSize: 9, color: "var(--hw-text-muted)", marginBottom: 4 }}>
        created {relativeTime(job.created_at)}
        {job.claimed_at && <> · claimed {relativeTime(job.claimed_at)}</>}
        {job.completed_at && <> · completed {relativeTime(job.completed_at)}</>}
      </div>

      {job.status === "failed" && job.error && (
        <div
          className="font-mono"
          style={{
            fontSize: 10,
            color: "var(--led-red)",
            background: "color-mix(in srgb, var(--led-red) 5%, transparent)",
            padding: "4px 8px",
            borderRadius: 3,
            marginTop: 4,
            wordBreak: "break-word",
          }}
        >
          {job.error}
        </div>
      )}

      {payload && (
        <div className="font-mono" style={{ fontSize: 9, color: "var(--hw-text-dim)", marginTop: 4 }}>
          {payload}
        </div>
      )}

      {result && (
        <div className="font-mono" style={{ fontSize: 9, color: "var(--led-green)", marginTop: 2 }}>
          → {result}
        </div>
      )}
    </div>
  );
}

/* ── Main panel ────────────────────────────────────────────────────────── */

interface PipelineDetailPanelProps {
  track: PipelineTrack;
  jobs: PipelineJob[];
  onClose: () => void;
}

export default function PipelineDetailPanel({ track, jobs, onClose }: PipelineDetailPanelProps) {
  const [flags, setFlags] = useState<TrackFlags | null>(null);

  const loadFlags = useCallback(async () => {
    try {
      const tracks = await fetchTracksByIds([track.id]);
      if (tracks.length > 0) {
        const t = tracks[0] as unknown as Record<string, unknown>;
        setFlags({
          fingerprinted: !!t.fingerprinted,
          enriched_spotify: !!t.enriched_spotify,
          enriched_audio: !!t.enriched_audio,
          metadata_written: !!t.metadata_written,
          cover_art_written: !!t.cover_art_written,
          in_library: !!t.in_library,
        });
      }
    } catch {
      // Flags section is optional — fail silently
    }
  }, [track.id]);

  useEffect(() => {
    loadFlags();
  }, [loadFlags]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const artistColor = (() => {
    let h = 0;
    for (let i = 0; i < track.artist.length; i++) {
      h = track.artist.charCodeAt(i) + ((h << 5) - h);
    }
    return `hsl(${((h % 360) + 360) % 360}, 55%, 45%)`;
  })();

  return (
    <>
      <style>{`
        @keyframes detailPanelSlideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>

      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.4)",
          zIndex: 59,
        }}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Job details for ${track.title}`}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          width: 380,
          height: "100vh",
          background: "var(--hw-surface)",
          borderLeft: "1px solid var(--hw-border)",
          zIndex: 60,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          animation: "detailPanelSlideIn 0.2s ease-out",
        }}
      >
        {/* Close button */}
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--hw-border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span className="font-mono uppercase" style={{ fontSize: 9, fontWeight: 700, color: "var(--hw-text-dim)", letterSpacing: 1.5 }}>
            Job Details
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--hw-text-dim)",
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "monospace",
            }}
          >
            ✕ Close
          </button>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {/* Track header */}
          <div className="flex gap-3" style={{ marginBottom: 20 }}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 4,
                backgroundImage: track.artwork_url
                  ? `url(${track.artwork_url})`
                  : `linear-gradient(135deg, ${artistColor}44 0%, ${artistColor}11 100%)`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {!track.artwork_url && (
                <span className="font-sans" style={{ fontSize: 16, fontWeight: 800, color: `${artistColor}88` }}>
                  {track.artist.slice(0, 2).toUpperCase()}
                </span>
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="font-sans truncate" style={{ fontSize: 14, fontWeight: 700, color: "var(--hw-text)" }}>
                {track.title}
              </div>
              <div className="font-sans truncate" style={{ fontSize: 12, color: "var(--hw-text-dim)" }}>
                {track.artist}
              </div>
              {track.album && (
                <div className="font-sans truncate" style={{ fontSize: 11, color: "var(--hw-text-muted)" }}>
                  {track.album}
                </div>
              )}
              <span
                className="font-mono uppercase inline-block"
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  marginTop: 4,
                  padding: "2px 8px",
                  borderRadius: 3,
                  color: "var(--hw-text-dim)",
                  background: "var(--hw-raised)",
                  border: "1px solid var(--hw-border)",
                }}
              >
                {track.acquisition_status.replace("_", " ")}
              </span>
            </div>
          </div>

          {/* Job timeline */}
          <div style={{ marginBottom: 20 }}>
            <span className="font-mono uppercase" style={{ fontSize: 9, fontWeight: 700, color: "var(--hw-text-dim)", letterSpacing: 1.5 }}>
              Job Timeline
            </span>
            <div className="flex flex-col gap-2" style={{ marginTop: 8 }}>
              {jobs.length === 0 ? (
                <span className="font-mono" style={{ fontSize: 11, color: "var(--hw-text-muted)" }}>
                  No jobs found for this track
                </span>
              ) : (
                jobs.map((job) => <JobTimelineEntry key={job.id} job={job} />)
              )}
            </div>
          </div>

          {/* Processing flags */}
          <div>
            <span className="font-mono uppercase" style={{ fontSize: 9, fontWeight: 700, color: "var(--hw-text-dim)", letterSpacing: 1.5 }}>
              Processing Flags
            </span>
            <div style={{ marginTop: 8 }}>
              {flags ? (
                <TrackFlagGrid flags={flags} />
              ) : (
                <span className="font-mono" style={{ fontSize: 10, color: "var(--hw-text-muted)" }}>
                  Loading...
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
