"use client";

import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import {
  fetchPipelineStatus,
  fetchPipelineJobs,
  type PipelineStatus,
  type PipelineJob,
  type PipelineJobList,
} from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

const API_URL = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api`;

function agentStatusColor(lastSeen: string): string {
  const diff = Date.now() - new Date(lastSeen).getTime();
  if (diff < 2 * 60 * 1000) return "bg-green-500";
  if (diff < 10 * 60 * 1000) return "bg-yellow-500";
  return "bg-red-500";
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
      return "bg-yellow-900/50 text-yellow-400 border-yellow-800";
    case "claimed":
    case "running":
      return "bg-blue-900/50 text-blue-400 border-blue-800";
    case "done":
      return "bg-green-900/50 text-green-400 border-green-800";
    case "failed":
      return "bg-red-900/50 text-red-400 border-red-800";
    default:
      return "bg-gray-800 text-gray-400 border-gray-700";
  }
}

function jobTypeBadge(t: string): string {
  switch (t) {
    case "download":
      return "bg-purple-900/50 text-purple-400";
    case "fingerprint":
      return "bg-cyan-900/50 text-cyan-400";
    case "cover_art":
      return "bg-pink-900/50 text-pink-400";
    case "metadata":
      return "bg-amber-900/50 text-amber-400";
    default:
      return "bg-gray-800 text-gray-400";
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

function JsonBlock({ data }: { data: Record<string, unknown> }) {
  return (
    <pre className="rounded bg-gray-950 border border-gray-800 p-3 text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap break-all">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function JobRow({ job }: { job: PipelineJob }) {
  const [expanded, setExpanded] = useState(false);
  const label =
    job.track_artist && job.track_title
      ? `${job.track_artist} - ${job.track_title}`
      : job.track_id
        ? `Track #${job.track_id}`
        : "Unknown";

  return (
    <div className="border-b border-gray-800 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/50 transition-colors"
      >
        <svg
          className={`h-3.5 w-3.5 text-gray-500 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
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

        <span className="flex-1 truncate text-sm text-white">{label}</span>

        {job.retry_count > 0 && (
          <span className="rounded bg-orange-900/50 px-1.5 py-0.5 text-xs text-orange-400">
            retry {job.retry_count}
          </span>
        )}

        <span className="text-xs text-gray-500 shrink-0">{relativeTime(job.created_at)}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pl-11 space-y-3">
          {/* Timeline */}
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
            <span>Created: {formatTimestamp(job.created_at)}</span>
            {job.claimed_at && <span>Claimed: {formatTimestamp(job.claimed_at)}</span>}
            {job.completed_at && <span>Completed: {formatTimestamp(job.completed_at)}</span>}
            {job.completed_at && job.claimed_at && (
              <span className="text-gray-400">
                Duration: {Math.round((new Date(job.completed_at).getTime() - new Date(job.claimed_at).getTime()) / 1000)}s
              </span>
            )}
          </div>

          {/* Payload */}
          {job.payload && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Payload</p>
              <JsonBlock data={job.payload} />
            </div>
          )}

          {/* Result */}
          {job.result && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Result</p>
              <JsonBlock data={job.result} />
            </div>
          )}

          {/* Error */}
          {job.error && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Error</p>
              <p className="rounded bg-red-950/50 border border-red-900 p-2 text-xs text-red-400">{job.error}</p>
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
  const [events, setEvents] = useState<string[]>([]);
  const sseRef = useRef<EventSource | null>(null);
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

    // SSE for real-time updates
    (async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const url = `${API_URL}/pipeline/events?token=${session.access_token}`;
      const es = new EventSource(url);
      sseRef.current = es;

      es.onmessage = (e) => {
        const data = JSON.parse(e.data);
        setEvents((prev) => [`${new Date().toLocaleTimeString()} — ${data.type}: ${JSON.stringify(data.data)}`, ...prev.slice(0, 49)]);
        if (data.type === "job_update" || data.type === "agent_heartbeat") {
          scheduleRefresh();
        }
      };
      es.onerror = () => es.close();
    })();

    return () => {
      sseRef.current?.close();
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
      <h1 className="text-xl font-bold text-white">Pipeline</h1>

      {status && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            { label: "Pending jobs", value: status.pending },
            { label: "Running jobs", value: status.running },
            { label: "Active agents", value: status.agents.length },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <p className="text-3xl font-bold text-white">{value}</p>
              <p className="text-sm text-gray-500">{label}</p>
            </div>
          ))}
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-gray-400 uppercase tracking-wider">Agents</h2>
        {!status || status.agents.length === 0 ? (
          <p className="text-sm text-gray-500">No agents registered. Go to Agents to set one up.</p>
        ) : (
          <div className="space-y-2">
            {status.agents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-4 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
                <span className={`h-2.5 w-2.5 rounded-full ${agentStatusColor(agent.last_seen_at)}`} />
                <div className="flex-1">
                  <p className="font-medium text-white">{agent.machine_name}</p>
                  <p className="text-xs text-gray-500">Last seen {relativeTime(agent.last_seen_at)}</p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {agent.capabilities.map((cap) => (
                    <span key={cap} className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">{cap}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Jobs */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            Jobs {jobData ? `(${jobData.total})` : ""}
          </h2>
          <div className="flex gap-2">
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setJobPage(1); }}
              className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300"
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
              onChange={(e) => { setTypeFilter(e.target.value); setJobPage(1); }}
              className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300"
            >
              <option value="">All types</option>
              <option value="download">Download</option>
              <option value="fingerprint">Fingerprint</option>
              <option value="cover_art">Cover Art</option>
              <option value="metadata">Metadata</option>
            </select>
          </div>
        </div>

        <div className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
          {!jobData || jobData.jobs.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-500">No jobs found.</p>
          ) : (
            jobData.jobs.map((job) => <JobRow key={job.id} job={job} />)
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
            <span>
              Page {jobData?.page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setJobPage((p) => Math.max(1, p - 1))}
                disabled={jobPage <= 1}
                className="rounded border border-gray-700 px-3 py-1 text-gray-400 hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Prev
              </button>
              <button
                onClick={() => setJobPage((p) => Math.min(totalPages, p + 1))}
                disabled={jobPage >= totalPages}
                className="rounded border border-gray-700 px-3 py-1 text-gray-400 hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>

      {events.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-gray-400 uppercase tracking-wider">Live Events</h2>
          <div className="rounded-lg border border-gray-800 bg-gray-950 p-3 font-mono text-xs text-gray-400 space-y-1 max-h-48 overflow-y-auto">
            {events.map((e, i) => <p key={i}>{e}</p>)}
          </div>
        </section>
      )}
    </div>
  );
}
