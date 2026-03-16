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

function jobStatusBadge(s: string): string {
  switch (s) {
    case "pending":
      return "bg-led-orange/20 text-led-orange border-led-orange/40";
    case "claimed":
    case "running":
      return "bg-led-blue/20 text-led-blue border-led-blue/40";
    case "done":
      return "bg-led-green/20 text-led-green border-led-green/40";
    case "failed":
      return "bg-led-red/20 text-led-red border-led-red/40";
    default:
      return "bg-hw-raised text-hw-text-dim border-hw-border";
  }
}

function jobTypeBadge(t: string): string {
  switch (t) {
    case "download":
      return "bg-led-blue/20 text-led-blue";
    case "fingerprint":
      return "bg-led-green/20 text-led-green";
    case "cover_art":
      return "bg-led-red/20 text-led-red";
    case "metadata":
      return "bg-led-orange/20 text-led-orange";
    default:
      return "bg-hw-raised text-hw-text-dim";
  }
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

function processingDuration(claimed: string | null, completed: string | null): string | null {
  if (!claimed || !completed) return null;
  const sec = Math.round((new Date(completed).getTime() - new Date(claimed).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

function JsonBlock({ data }: { data: Record<string, unknown> }) {
  return (
    <pre className="rounded bg-hw-body border border-hw-border p-3 text-xs text-hw-text overflow-x-auto whitespace-pre-wrap break-all">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function JobRow({
  job,
  selected,
  onSelect,
  onRetry,
}: {
  job: PipelineJob;
  selected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onRetry: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const canRetry = job.status === "failed" || job.status === "done";
  const label =
    job.track_artist && job.track_title
      ? `${job.track_artist} - ${job.track_title}`
      : job.track_id
        ? `Track #${job.track_id}`
        : "Unknown";

  const durationMs = (job.payload?.duration_ms as number) ?? null;
  const localPath = (job.result?.local_path as string) ?? (job.payload?.local_path as string) ?? null;
  const ext = fileExt(localPath);
  const procDur = processingDuration(job.claimed_at, job.completed_at);

  return (
    <div className="border-b border-hw-border last:border-b-0">
      <div className="flex items-center gap-3 px-4 py-3 hover:bg-hw-raised/50 transition-colors">
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

        {/* Artwork thumbnail */}
        {job.track_artwork_url ? (
          <img
            src={job.track_artwork_url}
            alt=""
            className="h-8 w-8 rounded shrink-0 object-cover"
          />
        ) : (
          <span className="h-8 w-8 rounded bg-hw-raised shrink-0 flex items-center justify-center text-hw-text-dim text-xs">
            {job.job_type === "download" ? "DL" : job.job_type === "fingerprint" ? "FP" : job.job_type === "cover_art" ? "CA" : "MD"}
          </span>
        )}

        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
        >
          <svg
            className={`h-3.5 w-3.5 text-hw-text-dim shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>

          <span className={`rounded border px-2 py-0.5 text-xs font-medium ${jobStatusBadge(job.status)}`}>
            {job.status}
          </span>
          <span className={`rounded px-2 py-0.5 text-xs ${jobTypeBadge(job.job_type)}`}>
            {job.job_type}
          </span>

          <div className="flex-1 min-w-0">
            <span className="truncate text-sm text-hw-text block">{label}</span>
            {job.track_album && (
              <span className="truncate text-xs text-hw-text-dim block">{job.track_album}</span>
            )}
          </div>

          {durationMs && (
            <span className="text-xs text-hw-text-dim shrink-0" title="Track duration">
              {formatDuration(durationMs)}
            </span>
          )}

          {ext && (
            <span className="rounded bg-hw-raised px-1.5 py-0.5 text-[10px] font-mono text-hw-text-dim shrink-0">
              {ext}
            </span>
          )}

          {job.retry_count > 0 && (
            <span className="rounded bg-led-orange/20 px-1.5 py-0.5 text-xs text-led-orange">
              retry {job.retry_count}
            </span>
          )}

          {procDur && (
            <span className="text-xs text-hw-text-dim shrink-0" title="Processing time">
              {procDur}
            </span>
          )}

          <span className="text-xs text-hw-text-dim shrink-0">{relativeTime(job.created_at)}</span>
        </button>

        {canRetry && (
          <button
            onClick={() => onRetry(job.id)}
            className="shrink-0 rounded border border-hw-border px-2 py-1 text-xs text-hw-text-dim hover:bg-hw-raised hover:text-hw-text transition-colors"
            title="Retry this job"
          >
            Retry
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-4 pb-4 pl-14 space-y-3">
          {/* Timeline */}
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-hw-text-dim">
            <span>Created: {formatTimestamp(job.created_at)}</span>
            {job.claimed_at && <span>Claimed: {formatTimestamp(job.claimed_at)}</span>}
            {job.completed_at && <span>Completed: {formatTimestamp(job.completed_at)}</span>}
            {job.completed_at && job.claimed_at && (
              <span className="text-hw-text-dim">
                Duration: {Math.round((new Date(job.completed_at).getTime() - new Date(job.claimed_at).getTime()) / 1000)}s
              </span>
            )}
          </div>

          {/* Payload */}
          {job.payload && (
            <div>
              <p className="text-xs font-medium text-hw-text-dim mb-1">Payload</p>
              <JsonBlock data={job.payload} />
            </div>
          )}

          {/* Result */}
          {job.result && (
            <div>
              <p className="text-xs font-medium text-hw-text-dim mb-1">Result</p>
              <JsonBlock data={job.result} />
            </div>
          )}

          {/* Error */}
          {job.error && (
            <div>
              <p className="text-xs font-medium text-hw-text-dim mb-1">Error</p>
              <p className="rounded bg-led-red/10 border border-led-red/30 p-2 text-xs text-led-red">{job.error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function PipelinePage() {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [jobData, setJobData] = useState<PipelineJobList | null>(null);
  const [jobPage, setJobPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>["channel"]> | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadStatus() {
    try {
      setStatus(await fetchPipelineStatus());
    } catch {
      // silently ignore — avoid toast spam during rapid updates
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
      // silently ignore — avoid toast spam during rapid updates
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

  const retryableJobs = jobData?.jobs.filter((j) => j.status === "failed" || j.status === "done") ?? [];
  const allRetryableSelected = retryableJobs.length > 0 && retryableJobs.every((j) => selectedIds.has(j.id));

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
      toast.success(`${retried} job${retried !== 1 ? "s" : ""} queued for retry`);
      setSelectedIds(new Set());
      loadStatus();
      loadJobs();
    } catch (err) {
      toast.error(`Retry failed: ${err instanceof Error ? err.message : err}`);
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
      toast.success(`${retried} job${retried !== 1 ? "s" : ""} queued for retry`);
      setSelectedIds(new Set());
      loadStatus();
      loadJobs();
    } catch (err) {
      toast.error(`Retry failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setRetrying(false);
    }
  }

  /** Debounced refresh — coalesces rapid SSE events into one fetch per 2s window. */
  function scheduleRefresh() {
    if (refreshTimerRef.current) return; // already scheduled
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
      const { data: { session } } = await supabase.auth.getSession();
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
              `${new Date().toLocaleTimeString()} — ${eventType}: ${(row?.job_type as string) ?? "unknown"} ${(row?.status as string) ?? ""}`,
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

  const totalPages = jobData ? Math.ceil(jobData.total / jobData.per_page) : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-hw-text">Pipeline</h1>

      {status && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            { label: "Pending jobs", value: status.pending },
            { label: "Running jobs", value: status.running },
            { label: "Active agents", value: status.agents.length },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-lg border border-hw-border bg-hw-surface p-4">
              <p className="text-3xl font-bold text-hw-text">{value}</p>
              <p className="text-sm text-hw-text-dim">{label}</p>
            </div>
          ))}
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-hw-text-dim uppercase tracking-wider">Agents</h2>
        {!status || status.agents.length === 0 ? (
          <p className="text-sm text-hw-text-dim">No agents registered. Go to Agents to set one up.</p>
        ) : (
          <div className="space-y-2">
            {status.agents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-4 rounded-lg border border-hw-border bg-hw-surface px-4 py-3">
                <span className={`h-2.5 w-2.5 rounded-full ${agentStatusColor(agent.last_seen_at)}`} />
                <div className="flex-1">
                  <p className="font-medium text-hw-text">{agent.machine_name}</p>
                  <p className="text-xs text-hw-text-dim">Last seen {relativeTime(agent.last_seen_at)}</p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {agent.capabilities.map((cap) => (
                    <span key={cap} className="rounded bg-hw-raised px-2 py-0.5 text-xs text-hw-text-dim">{cap}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Jobs */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-hw-text-dim uppercase tracking-wider">
            Jobs {jobData ? `(${jobData.total})` : ""}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {selectedIds.size > 0 && (
              <button
                onClick={() => handleRetry(Array.from(selectedIds))}
                disabled={retrying}
                className="rounded bg-led-blue px-3 py-1 text-xs font-medium text-hw-text hover:bg-led-blue/80 disabled:opacity-50 transition-colors"
              >
                {retrying ? "Retrying..." : `Retry Selected (${selectedIds.size})`}
              </button>
            )}
            {(statusFilter === "failed" || statusFilter === "done") && (
              <button
                onClick={handleRetryAllFiltered}
                disabled={retrying}
                className="rounded border border-led-blue/40 px-3 py-1 text-xs font-medium text-led-blue hover:bg-led-blue/10 disabled:opacity-50 transition-colors"
              >
                {retrying ? "Retrying..." : `Retry All ${statusFilter}${typeFilter ? ` ${typeFilter}` : ""}`}
              </button>
            )}
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setJobPage(1); setSelectedIds(new Set()); }}
              className="rounded border border-hw-border bg-hw-surface px-2 py-1 text-xs text-hw-text"
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="claimed">Claimed</option>
              <option value="running">Running</option>
              <option value="done">Done</option>
              <option value="failed">Failed</option>
            </select>
            <select
              value={typeFilter}
              onChange={(e) => { setTypeFilter(e.target.value); setJobPage(1); setSelectedIds(new Set()); }}
              className="rounded border border-hw-border bg-hw-surface px-2 py-1 text-xs text-hw-text"
            >
              <option value="">All types</option>
              <option value="download">Download</option>
              <option value="fingerprint">Fingerprint</option>
              <option value="cover_art">Cover Art</option>
              <option value="metadata">Metadata</option>
            </select>
          </div>
        </div>

        <div className="rounded-lg border border-hw-border bg-hw-surface overflow-hidden">
          {!jobData || jobData.jobs.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-hw-text-dim">No jobs found.</p>
          ) : (
            <>
              {retryableJobs.length > 0 && (
                <div className="flex items-center gap-2 px-4 py-2 border-b border-hw-border bg-hw-surface/50">
                  <input
                    type="checkbox"
                    checked={allRetryableSelected}
                    onChange={(e) => toggleSelectAll(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[#4488FF] cursor-pointer"
                  />
                  <span className="text-xs text-hw-text-dim">Select all retryable on this page</span>
                </div>
              )}
              {jobData.jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  selected={selectedIds.has(job.id)}
                  onSelect={toggleSelect}
                  onRetry={(id) => handleRetry([id])}
                />
              ))}
            </>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-3 flex items-center justify-between text-xs text-hw-text-dim">
            <span>
              Page {jobData?.page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setJobPage((p) => Math.max(1, p - 1))}
                disabled={jobPage <= 1}
                className="rounded border border-hw-border px-3 py-1 text-hw-text-dim hover:bg-hw-raised disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Prev
              </button>
              <button
                onClick={() => setJobPage((p) => Math.min(totalPages, p + 1))}
                disabled={jobPage >= totalPages}
                className="rounded border border-hw-border px-3 py-1 text-hw-text-dim hover:bg-hw-raised disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>

      {events.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-hw-text-dim uppercase tracking-wider">Live Events</h2>
          <div className="rounded-lg border border-hw-border bg-hw-body p-3 font-mono text-xs text-led-green space-y-1 max-h-48 overflow-y-auto">
            {events.map((e, i) => <p key={i}>{e}</p>)}
          </div>
        </section>
      )}
    </div>
  );
}
