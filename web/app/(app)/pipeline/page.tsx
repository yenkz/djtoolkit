"use client";

import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import {
  fetchPipelineStatus,
  fetchPipelineJobs,
  retryPipelineJobs,
  type PipelineStatus,
  type PipelineJob,
  type PipelineJobList,
} from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import LCDDisplay from "@/components/ui/LCDDisplay";
import FilterSelect from "@/components/ui/FilterSelect";

/* ── helpers ─────────────────────────────────────────────────────────────── */

function agentStatusColor(lastSeen: string): string {
  const diff = Date.now() - new Date(lastSeen).getTime();
  if (diff < 2 * 60 * 1000) return "bg-led-green";
  if (diff < 10 * 60 * 1000) return "bg-led-orange";
  return "bg-led-red";
}

function relativeTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function fileExt(path: string | undefined | null): string | null {
  if (!path) return null;
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return path.slice(dot + 1).toUpperCase();
}

function processingDuration(
  claimed: string | null,
  completed: string | null
): string | null {
  if (!claimed || !completed) return null;
  const sec = Math.round(
    (new Date(completed).getTime() - new Date(claimed).getTime()) / 1000
  );
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

/* ── LED color maps ──────────────────────────────────────────────────────── */

const STATUS_LED: Record<string, { color: string; bg: string; border: string }> = {
  pending: {
    color: "var(--led-orange)",
    bg: "color-mix(in srgb, var(--led-orange) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-orange) 20%, transparent)",
  },
  claimed: {
    color: "var(--led-blue)",
    bg: "color-mix(in srgb, var(--led-blue) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-blue) 20%, transparent)",
  },
  running: {
    color: "var(--led-blue)",
    bg: "color-mix(in srgb, var(--led-blue) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-blue) 20%, transparent)",
  },
  done: {
    color: "var(--led-green)",
    bg: "color-mix(in srgb, var(--led-green) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-green) 20%, transparent)",
  },
  failed: {
    color: "var(--led-red)",
    bg: "color-mix(in srgb, var(--led-red) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-red) 20%, transparent)",
  },
};

const TYPE_LED: Record<string, string> = {
  download: "var(--led-blue)",
  fingerprint: "var(--led-green)",
  cover_art: "var(--led-red)",
  metadata: "var(--led-orange)",
};

/* ── sub-components ──────────────────────────────────────────────────────── */

function StatusBadge({ status }: { status: string }) {
  const led = STATUS_LED[status] ?? STATUS_LED.pending;
  return (
    <span
      className="font-mono shrink-0"
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.5,
        color: led.color,
        background: led.bg,
        border: `1px solid ${led.border}`,
        padding: "3px 10px",
        borderRadius: 4,
        textTransform: "lowercase",
        textShadow: `0 0 6px ${led.color}44`,
      }}
    >
      {status}
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  const c = TYPE_LED[type] ?? "var(--hw-text-dim)";
  return (
    <span
      className="font-mono shrink-0"
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.5,
        color: c,
        background: `color-mix(in srgb, ${c} 7%, transparent)`,
        border: `1px solid color-mix(in srgb, ${c} 20%, transparent)`,
        padding: "3px 10px",
        borderRadius: 4,
      }}
    >
      {type}
    </span>
  );
}

function RetryButton({
  retryCount,
  onClick,
}: {
  retryCount: number;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="font-mono shrink-0 transition-all duration-150"
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: hovered ? "var(--led-orange)" : "var(--hw-text-dim)",
        background: hovered
          ? "color-mix(in srgb, var(--led-orange) 12%, transparent)"
          : "transparent",
        border: `1px solid ${
          hovered
            ? "color-mix(in srgb, var(--led-orange) 20%, transparent)"
            : "var(--hw-list-border, var(--hw-border))"
        }`,
        padding: "3px 10px",
        borderRadius: 4,
        cursor: "pointer",
      }}
    >
      retry{retryCount > 0 ? ` ${retryCount}` : ""}
    </button>
  );
}

function JsonBlock({ data }: { data: Record<string, unknown> }) {
  return (
    <pre
      className="font-mono overflow-x-auto whitespace-pre-wrap break-all"
      style={{
        fontSize: 12,
        color: "var(--hw-text-sec, var(--hw-text-dim))",
        background: "var(--hw-body)",
        border: "1px solid var(--hw-border)",
        borderRadius: 5,
        padding: 14,
        margin: 0,
        lineHeight: 1.6,
      }}
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

/* ── JobRow ───────────────────────────────────────────────────────────────── */

function JobRow({
  job,
  selected,
  onSelect,
  onRetry,
  expanded,
  onToggle,
}: {
  job: PipelineJob;
  selected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onRetry: (id: string) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const canRetry = job.status === "failed" || job.status === "done";
  const label =
    job.track_artist && job.track_title
      ? `${job.track_artist} - ${job.track_title}`
      : job.track_id
        ? `Track #${job.track_id}`
        : "Unknown";

  const durationMs = (job.payload?.duration_ms as number) ?? null;
  const localPath =
    (job.result?.local_path as string) ??
    (job.payload?.local_path as string) ??
    null;
  const ext = fileExt(localPath);
  const procDur = processingDuration(job.claimed_at, job.completed_at);

  return (
    <div style={{ borderBottom: "1px solid var(--hw-list-border, var(--hw-border))" }}>
      {/* Main row */}
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onToggle}
        className="flex items-center gap-2.5 transition-colors"
        style={{
          padding: "12px 16px",
          cursor: "pointer",
          background: hovered
            ? "var(--hw-list-row-hover, var(--hw-raised))"
            : "var(--hw-list-row-bg, var(--hw-surface))",
        }}
      >
        {/* Checkbox */}
        {canRetry && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(job.id, e.target.checked)}
            className="h-3.5 w-3.5 shrink-0 accent-[#4488FF] cursor-pointer"
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {!canRetry && <span className="w-3.5 shrink-0" />}

        {/* Expand chevron */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="var(--hw-text-muted)"
          strokeWidth="1.5"
          strokeLinecap="round"
          className="shrink-0 transition-transform duration-200"
          style={{ transform: expanded ? "rotate(90deg)" : "none" }}
        >
          <path d="M6 3l5 5-5 5" />
        </svg>

        {/* Badges */}
        <StatusBadge status={job.status} />
        <TypeBadge type={job.job_type} />

        {/* Title + album */}
        <div className="flex-1 min-w-0">
          <span
            className="truncate text-sm block"
            style={{ fontWeight: 600, color: "var(--hw-text)" }}
          >
            {label}
          </span>
          {job.track_album && (
            <span
              className="truncate text-xs block"
              style={{ color: "var(--hw-text-dim)" }}
            >
              {job.track_album}
            </span>
          )}
        </div>

        {/* Right side metadata */}
        <div className="flex items-center gap-2.5 shrink-0">
          {durationMs && (
            <span
              className="font-mono"
              style={{ fontSize: 11, color: "var(--hw-text-dim)" }}
              title="Track duration"
            >
              {formatDuration(durationMs)}
            </span>
          )}

          {ext && (
            <span
              className="font-mono"
              style={{
                fontSize: 10,
                color: "var(--hw-text-dim)",
                background: "var(--hw-raised)",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              {ext}
            </span>
          )}

          {job.retry_count > 0 && (
            <RetryButton
              retryCount={job.retry_count}
              onClick={() => onRetry(job.id)}
            />
          )}

          {procDur && (
            <span
              className="font-mono"
              style={{ fontSize: 11, color: "var(--hw-text-dim)" }}
              title="Processing time"
            >
              {procDur}
            </span>
          )}

          <span
            className="font-mono"
            style={{
              fontSize: 11,
              color: "var(--hw-text-muted)",
              minWidth: 60,
              textAlign: "right",
            }}
          >
            {relativeTime(job.created_at)}
          </span>

          {canRetry && job.retry_count === 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRetry(job.id);
              }}
              className="font-mono shrink-0 transition-colors duration-150"
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "var(--hw-text-dim)",
                background: "transparent",
                border: "1px solid var(--hw-list-border, var(--hw-border))",
                padding: "3px 10px",
                borderRadius: 4,
                cursor: "pointer",
              }}
              title="Retry this job"
            >
              Retry
            </button>
          )}
        </div>
      </div>

      {/* Expanded detail */}
      <div
        style={{
          overflow: "hidden",
          maxHeight: expanded ? 600 : 0,
          opacity: expanded ? 1 : 0,
          transition: "max-height 0.3s ease, opacity 0.2s ease",
        }}
      >
        <div
          style={{
            padding: "0 16px 16px 56px",
            background: "var(--hw-list-row-bg, var(--hw-surface))",
          }}
        >
          {/* Timestamps */}
          <div className="flex flex-wrap gap-x-6 gap-y-2 mb-3.5">
            {[
              { label: "Created", value: formatTimestamp(job.created_at) },
              {
                label: "Claimed",
                value: job.claimed_at
                  ? formatTimestamp(job.claimed_at)
                  : "\u2014",
              },
              {
                label: "Completed",
                value: job.completed_at
                  ? formatTimestamp(job.completed_at)
                  : "\u2014",
              },
              {
                label: "Duration",
                value:
                  job.completed_at && job.claimed_at
                    ? `${Math.round(
                        (new Date(job.completed_at).getTime() -
                          new Date(job.claimed_at).getTime()) /
                          1000
                      )}s`
                    : "\u2014",
              },
            ].map((t) => (
              <div key={t.label}>
                <div
                  className="font-mono uppercase"
                  style={{
                    fontSize: 9,
                    color: "var(--hw-text-muted)",
                    letterSpacing: 1,
                    marginBottom: 3,
                  }}
                >
                  {t.label}
                </div>
                <div style={{ fontSize: 12, color: "var(--hw-text-dim)" }}>
                  {t.value}
                </div>
              </div>
            ))}
          </div>

          {/* Payload */}
          {job.payload && (
            <div className="mb-3.5">
              <div
                className="font-mono uppercase mb-1.5"
                style={{
                  fontSize: 9,
                  color: "var(--hw-text-muted)",
                  letterSpacing: 1,
                }}
              >
                Payload
              </div>
              <JsonBlock data={job.payload} />
            </div>
          )}

          {/* Result */}
          {job.result && (
            <div className="mb-3.5">
              <div
                className="font-mono uppercase mb-1.5"
                style={{
                  fontSize: 9,
                  color: "var(--hw-text-muted)",
                  letterSpacing: 1,
                }}
              >
                Result
              </div>
              <JsonBlock data={job.result} />
            </div>
          )}

          {/* Error */}
          {job.error && (
            <div>
              <div
                className="font-mono uppercase mb-1.5"
                style={{
                  fontSize: 9,
                  color: "var(--hw-text-muted)",
                  letterSpacing: 1,
                }}
              >
                Error
              </div>
              <div
                className="font-mono"
                style={{
                  fontSize: 12,
                  color: "var(--led-red)",
                  background:
                    "color-mix(in srgb, var(--led-red) 7%, transparent)",
                  border:
                    "1px solid color-mix(in srgb, var(--led-red) 20%, transparent)",
                  borderRadius: 5,
                  padding: "10px 14px",
                }}
              >
                {job.error}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function PipelinePage() {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [jobData, setJobData] = useState<PipelineJobList | null>(null);
  const [jobPage, setJobPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const channelRef = useRef<ReturnType<
    ReturnType<typeof createClient>["channel"]
  > | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadStatus() {
    try {
      setStatus(await fetchPipelineStatus());
    } catch {
      // silently ignore -- avoid toast spam during rapid updates
    }
  }

  async function loadJobs() {
    try {
      setJobData(
        await fetchPipelineJobs({
          page: jobPage,
          per_page: 50,
          status: statusFilter || undefined,
          job_type: typeFilter || undefined,
        })
      );
    } catch {
      // silently ignore -- avoid toast spam during rapid updates
    }
  }

  function toggleSelect(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const retryableJobs =
    jobData?.jobs.filter(
      (j) => j.status === "failed" || j.status === "done"
    ) ?? [];
  const allRetryableSelected =
    retryableJobs.length > 0 &&
    retryableJobs.every((j) => selectedIds.has(j.id));

  function toggleSelectAll(checked: boolean) {
    if (checked) {
      setSelectedIds(new Set(retryableJobs.map((j) => j.id)));
    } else {
      setSelectedIds(new Set());
    }
  }

  async function handleRetry(jobIds: string[]) {
    if (jobIds.length === 0) return;
    setRetrying(true);
    try {
      const { retried } = await retryPipelineJobs({ job_ids: jobIds });
      toast.success(
        `${retried} job${retried !== 1 ? "s" : ""} queued for retry`
      );
      setSelectedIds(new Set());
      loadStatus();
      loadJobs();
    } catch (err) {
      toast.error(
        `Retry failed: ${err instanceof Error ? err.message : err}`
      );
    } finally {
      setRetrying(false);
    }
  }

  async function handleRetryAllFiltered() {
    setRetrying(true);
    try {
      const { retried } = await retryPipelineJobs({
        filter_status: statusFilter || "failed",
        filter_job_type: typeFilter || undefined,
      });
      toast.success(
        `${retried} job${retried !== 1 ? "s" : ""} queued for retry`
      );
      setSelectedIds(new Set());
      loadStatus();
      loadJobs();
    } catch (err) {
      toast.error(
        `Retry failed: ${err instanceof Error ? err.message : err}`
      );
    } finally {
      setRetrying(false);
    }
  }

  /** Debounced refresh -- coalesces rapid SSE events into one fetch per 2s window. */
  function scheduleRefresh() {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      loadStatus();
      loadJobs();
    }, 2000);
  }

  useEffect(() => {
    loadStatus();
    loadJobs();

    // Subscribe to pipeline job changes via Supabase Realtime
    (async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;

      const channel = supabase
        .channel("pipeline-jobs")
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "pipeline_jobs",
            filter: `user_id=eq.${session.user.id}`,
          },
          (payload) => {
            const { eventType, new: newRow } = payload;
            const row = newRow as Record<string, unknown> | null;
            setEvents((prev) => [
              `${new Date().toLocaleTimeString()} \u2014 ${eventType}: ${(row?.job_type as string) ?? "unknown"} ${(row?.status as string) ?? ""}`,
              ...prev.slice(0, 49),
            ]);
            scheduleRefresh();
          }
        )
        .subscribe();

      channelRef.current = channel;
    })();

    return () => {
      if (channelRef.current) {
        const supabase = createClient();
        supabase.removeChannel(channelRef.current);
      }
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  // Reload jobs when filters or page change
  useEffect(() => {
    loadJobs();
  }, [jobPage, statusFilter, typeFilter]);

  const totalPages = jobData
    ? Math.ceil(jobData.total / jobData.per_page)
    : 0;

  /* Compute stat counts from status response + job data */
  const pendingCount = status?.pending ?? 0;
  const runningCount = status?.running ?? 0;
  const completedCount =
    jobData?.jobs.filter((j) => j.status === "done").length ?? 0;
  const failedCount =
    jobData?.jobs.filter((j) => j.status === "failed").length ?? 0;

  return (
    <div className="space-y-6">
      <h1
        className="font-bold"
        style={{
          fontSize: 28,
          fontWeight: 900,
          letterSpacing: -1,
          color: "var(--hw-text)",
        }}
      >
        Pipeline
      </h1>

      {/* Stat cards row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <LCDDisplay value={pendingCount} label="Pending" />
        <LCDDisplay value={runningCount} label="Running" />
        <LCDDisplay value={completedCount} label="Completed" />
        <LCDDisplay value={failedCount} label="Failed" />
      </div>

      {/* Agents section */}
      <section>
        <h2
          className="mb-3 font-mono uppercase"
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "var(--hw-text-dim)",
            letterSpacing: 1.5,
          }}
        >
          Agents
        </h2>
        {!status || status.agents.length === 0 ? (
          <p style={{ fontSize: 14, color: "var(--hw-text-dim)" }}>
            No agents registered. Go to Agents to set one up.
          </p>
        ) : (
          <div className="space-y-2">
            {status.agents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center gap-4 rounded-lg px-4 py-3"
                style={{
                  background: "var(--hw-surface)",
                  border: "1px solid var(--hw-border)",
                }}
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full ${agentStatusColor(agent.last_seen_at)}`}
                />
                <div className="flex-1">
                  <p
                    className="font-medium"
                    style={{ color: "var(--hw-text)" }}
                  >
                    {agent.machine_name}
                  </p>
                  <p
                    style={{
                      fontSize: 12,
                      color: "var(--hw-text-dim)",
                    }}
                  >
                    Last seen {relativeTime(agent.last_seen_at)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {agent.capabilities.map((cap) => (
                    <span
                      key={cap}
                      className="rounded px-2 py-0.5"
                      style={{
                        fontSize: 12,
                        color: "var(--hw-text-dim)",
                        background: "var(--hw-raised)",
                      }}
                    >
                      {cap}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Jobs section */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span
            className="font-mono uppercase"
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--hw-text-dim)",
              letterSpacing: 1.5,
            }}
          >
            Jobs {jobData ? `(${jobData.total})` : ""}
          </span>

          <div className="flex flex-wrap items-center gap-2">
            {selectedIds.size > 0 && (
              <button
                onClick={() => handleRetry(Array.from(selectedIds))}
                disabled={retrying}
                className="font-mono transition-colors duration-150 disabled:opacity-50"
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "var(--hw-text)",
                  background: "var(--led-blue)",
                  border: "none",
                  borderRadius: 5,
                  padding: "7px 14px",
                  cursor: "pointer",
                }}
              >
                {retrying
                  ? "Retrying..."
                  : `Retry Selected (${selectedIds.size})`}
              </button>
            )}

            {(statusFilter === "failed" || statusFilter === "done") && (
              <button
                onClick={handleRetryAllFiltered}
                disabled={retrying}
                className="font-mono transition-colors duration-150 disabled:opacity-50"
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "var(--led-blue)",
                  background: "transparent",
                  border: "1px solid color-mix(in srgb, var(--led-blue) 27%, transparent)",
                  borderRadius: 5,
                  padding: "7px 14px",
                  cursor: "pointer",
                }}
              >
                {retrying
                  ? "Retrying..."
                  : `Retry All ${statusFilter}${typeFilter ? ` ${typeFilter}` : ""}`}
              </button>
            )}

            <FilterSelect
              value={statusFilter}
              onChange={(v) => {
                setStatusFilter(v);
                setJobPage(1);
                setSelectedIds(new Set());
              }}
              options={[
                { value: "", label: "All statuses" },
                { value: "pending", label: "Pending" },
                { value: "claimed", label: "Claimed" },
                { value: "running", label: "Running" },
                { value: "done", label: "Done" },
                { value: "failed", label: "Failed" },
              ]}
            />

            <FilterSelect
              value={typeFilter}
              onChange={(v) => {
                setTypeFilter(v);
                setJobPage(1);
                setSelectedIds(new Set());
              }}
              options={[
                { value: "", label: "All types" },
                { value: "download", label: "Download" },
                { value: "fingerprint", label: "Fingerprint" },
                { value: "cover_art", label: "Cover Art" },
                { value: "metadata", label: "Metadata" },
              ]}
            />
          </div>
        </div>

        {/* Jobs list */}
        <div
          className="rounded-md overflow-hidden"
          style={{
            background: "var(--hw-list-bg, var(--hw-surface))",
            border: "1.5px solid var(--hw-list-border, var(--hw-border))",
            boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
          }}
        >
          {!jobData || jobData.jobs.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center" }}>
              <span style={{ fontSize: 14, color: "var(--hw-text-dim)" }}>
                No jobs found.
              </span>
            </div>
          ) : (
            <>
              {retryableJobs.length > 0 && (
                <div
                  className="flex items-center gap-2 px-4 py-2"
                  style={{
                    borderBottom:
                      "1px solid var(--hw-list-border, var(--hw-border))",
                    background: "var(--hw-list-header, var(--hw-surface))",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allRetryableSelected}
                    onChange={(e) => toggleSelectAll(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[#4488FF] cursor-pointer"
                  />
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--hw-text-dim)",
                    }}
                  >
                    Select all retryable on this page
                  </span>
                </div>
              )}
              {jobData.jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  selected={selectedIds.has(job.id)}
                  onSelect={toggleSelect}
                  onRetry={(id) => handleRetry([id])}
                  expanded={expandedJobId === job.id}
                  onToggle={() =>
                    setExpandedJobId(
                      expandedJobId === job.id ? null : job.id
                    )
                  }
                />
              ))}
            </>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            className="mt-3 flex items-center justify-between font-mono"
            style={{ fontSize: 12, color: "var(--hw-text-dim)" }}
          >
            <span>
              Page {jobData?.page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setJobPage((p) => Math.max(1, p - 1))}
                disabled={jobPage <= 1}
                className="rounded transition-colors duration-150 disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  border: "1px solid var(--hw-border)",
                  padding: "4px 12px",
                  color: "var(--hw-text-dim)",
                  background: "transparent",
                  cursor: "pointer",
                }}
              >
                Prev
              </button>
              <button
                onClick={() =>
                  setJobPage((p) => Math.min(totalPages, p + 1))
                }
                disabled={jobPage >= totalPages}
                className="rounded transition-colors duration-150 disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  border: "1px solid var(--hw-border)",
                  padding: "4px 12px",
                  color: "var(--hw-text-dim)",
                  background: "transparent",
                  cursor: "pointer",
                }}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Live events terminal */}
      {events.length > 0 && (
        <section>
          <h2
            className="mb-3 font-mono uppercase"
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--hw-text-dim)",
              letterSpacing: 1.5,
            }}
          >
            Live Events
          </h2>
          <div
            className="rounded-lg font-mono space-y-1 max-h-48 overflow-y-auto"
            style={{
              background: "var(--hw-body)",
              border: "1px solid var(--hw-border)",
              padding: 12,
              fontSize: 12,
              color: "var(--led-green)",
            }}
          >
            {events.map((e, i) => (
              <p key={i}>{e}</p>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
