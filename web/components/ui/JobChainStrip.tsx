"use client";

import { type PipelineJob } from "@/lib/api";

/* ── Job type display order ─────────────────────────────────────────────── */

const JOB_ORDER = ["download", "fingerprint", "spotify_lookup", "cover_art", "audio_analysis", "metadata"];

const JOB_LABELS: Record<string, string> = {
  download: "DL",
  fingerprint: "FP",
  spotify_lookup: "SP",
  cover_art: "ART",
  audio_analysis: "AA",
  metadata: "META",
};

const STATUS_COLORS: Record<string, { color: string; bg: string; border: string }> = {
  done: {
    color: "var(--led-green)",
    bg: "color-mix(in srgb, var(--led-green) 10%, transparent)",
    border: "color-mix(in srgb, var(--led-green) 30%, transparent)",
  },
  failed: {
    color: "var(--led-red)",
    bg: "color-mix(in srgb, var(--led-red) 10%, transparent)",
    border: "color-mix(in srgb, var(--led-red) 30%, transparent)",
  },
  pending: {
    color: "var(--led-blue)",
    bg: "color-mix(in srgb, var(--led-blue) 10%, transparent)",
    border: "color-mix(in srgb, var(--led-blue) 30%, transparent)",
  },
  claimed: {
    color: "var(--led-orange)",
    bg: "color-mix(in srgb, var(--led-orange) 10%, transparent)",
    border: "color-mix(in srgb, var(--led-orange) 30%, transparent)",
  },
  running: {
    color: "var(--led-blue)",
    bg: "color-mix(in srgb, var(--led-blue) 10%, transparent)",
    border: "color-mix(in srgb, var(--led-blue) 30%, transparent)",
  },
};

const DEFAULT_COLORS = {
  color: "var(--hw-text-muted)",
  bg: "transparent",
  border: "var(--hw-border)",
};

/* ── Component ──────────────────────────────────────────────────────────── */

interface JobChainStripProps {
  jobs: PipelineJob[];
  source: string | null;
  onViewDetails: () => void;
}

export default function JobChainStrip({ jobs, source, onViewDetails }: JobChainStripProps) {
  // Group by job_type and pick the latest job per type
  const latestByType: Record<string, PipelineJob> = {};
  for (const job of jobs) {
    const existing = latestByType[job.job_type];
    if (!existing || new Date(job.created_at) > new Date(existing.created_at)) {
      latestByType[job.job_type] = job;
    }
  }

  // Build the ordered chain
  const chain = JOB_ORDER.map((type) => ({
    type,
    label: JOB_LABELS[type] ?? type,
    job: latestByType[type] ?? null,
  }));

  return (
    <div
      className="flex items-center gap-2"
      style={{ padding: "10px 16px 10px 88px" }}
    >
      {/* Source badge */}
      {source && (
        <span
          className="font-mono uppercase shrink-0"
          style={{
            fontSize: 8,
            fontWeight: 700,
            letterSpacing: 1,
            color: "var(--hw-text-muted)",
            background: "var(--hw-raised)",
            border: "1px solid var(--hw-border)",
            padding: "2px 6px",
            borderRadius: 3,
          }}
        >
          {source}
        </span>
      )}

      {/* Job pills */}
      <div className="flex items-center gap-1">
        {chain.map(({ type, label, job }) => {
          const status = job?.status;
          const colors = status ? (STATUS_COLORS[status] ?? DEFAULT_COLORS) : DEFAULT_COLORS;
          const isActive = !!job;

          return (
            <span
              key={type}
              className="font-mono uppercase"
              title={job ? `${type}: ${job.status}${job.error ? ` — ${job.error}` : ""}` : `${type}: not started`}
              style={{
                fontSize: 8,
                fontWeight: 700,
                letterSpacing: 0.5,
                padding: "3px 6px",
                borderRadius: 3,
                color: isActive ? colors.color : "var(--hw-text-muted)",
                background: isActive ? colors.bg : "transparent",
                border: `1px solid ${isActive ? colors.border : "var(--hw-border)"}`,
                opacity: isActive ? 1 : 0.4,
                ...(status === "claimed" || status === "running"
                  ? { animation: "led-pulse 1.5s infinite" }
                  : {}),
              }}
            >
              {label}
            </span>
          );
        })}
      </div>

      {/* Connector */}
      <span style={{ color: "var(--hw-text-muted)", fontSize: 10 }}>·</span>

      {/* Job count */}
      <span
        className="font-mono"
        style={{ fontSize: 10, color: "var(--hw-text-muted)" }}
      >
        {jobs.length} job{jobs.length !== 1 ? "s" : ""}
      </span>

      {/* View Details link */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onViewDetails();
        }}
        className="font-mono"
        style={{
          fontSize: 10,
          color: "var(--led-blue)",
          background: "none",
          border: "none",
          cursor: "pointer",
          textDecoration: "underline",
          textUnderlineOffset: 2,
          marginLeft: "auto",
        }}
      >
        View Details
      </button>
    </div>
  );
}
