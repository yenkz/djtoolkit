"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  fetchPipelineMonitorStatus,
  fetchPipelineTracks,
  retryPipelineTrack,
  bulkPipelineAction,
  bulkCreateJobs,
  fetchTrackJobs,
  type PipelineMonitorStatus,
  type PipelineTrack,
  type PipelineTrackList,
  type PipelineJob,
  type AcquisitionStatus,
} from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import LCDDisplay from "@/components/ui/LCDDisplay";
import MiniSearch from "@/components/ui/MiniSearch";
import JobChainStrip from "@/components/ui/JobChainStrip";
import PipelineDetailPanel from "@/components/ui/PipelineDetailPanel";

/* ── LED color map ──────────────────────────────────────────────────────── */

const STATUS_LED: Record<
  string,
  { color: string; bg: string; border: string; pulse?: boolean }
> = {
  candidate: {
    color: "var(--hw-text-dim)",
    bg: "transparent",
    border: "transparent",
  },
  searching: {
    color: "var(--led-orange)",
    bg: "color-mix(in srgb, var(--led-orange) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-orange) 20%, transparent)",
    pulse: true,
  },
  found: {
    color: "var(--led-green)",
    bg: "color-mix(in srgb, var(--led-green) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-green) 20%, transparent)",
  },
  not_found: {
    color: "var(--led-red)",
    bg: "color-mix(in srgb, var(--led-red) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-red) 20%, transparent)",
  },
  queued: {
    color: "var(--led-blue)",
    bg: "color-mix(in srgb, var(--led-blue) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-blue) 20%, transparent)",
  },
  downloading: {
    color: "var(--led-blue)",
    bg: "color-mix(in srgb, var(--led-blue) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-blue) 20%, transparent)",
    pulse: true,
  },
  failed: {
    color: "var(--led-red)",
    bg: "color-mix(in srgb, var(--led-red) 7%, transparent)",
    border: "color-mix(in srgb, var(--led-red) 20%, transparent)",
  },
  paused: {
    color: "var(--hw-text-dim)",
    bg: "color-mix(in srgb, var(--hw-text-dim) 7%, transparent)",
    border: "color-mix(in srgb, var(--hw-text-dim) 20%, transparent)",
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

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

/* ── Filter options ──────────────────────────────────────────────────────── */

const FILTER_OPTIONS: { value: AcquisitionStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "candidate", label: "Candidate" },
  { value: "searching", label: "Searching" },
  { value: "found", label: "Found" },
  { value: "queued", label: "Queued" },
  { value: "downloading", label: "Downloading" },
  { value: "not_found", label: "Not Found" },
  { value: "failed", label: "Failed" },
  { value: "paused", label: "Paused" },
];

/* ── Sub-components ──────────────────────────────────────────────────────── */

function StatusBadge({ status }: { status: string }) {
  const led = STATUS_LED[status] ?? STATUS_LED.candidate;
  return (
    <span
      className="font-mono shrink-0 inline-flex items-center gap-1.5"
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.5,
        color: led.color,
        background: led.bg,
        border: `1px solid ${led.border}`,
        padding: "3px 10px",
        borderRadius: 4,
        textTransform: "uppercase",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: led.color,
          ...(led.pulse ? { animation: "led-pulse 1.5s infinite" } : {}),
        }}
      />
      {status.replace("_", " ")}
    </span>
  );
}

/* ── Sort arrow indicator ─────────────────────────────────────────────────── */

function SortArrow({
  column,
  sortBy,
  sortDir,
}: {
  column: string;
  sortBy: string;
  sortDir: "asc" | "desc";
}) {
  if (sortBy !== column) return null;
  return (
    <span style={{ marginLeft: 4, fontSize: 10 }}>
      {sortDir === "asc" ? "\u25B2" : "\u25BC"}
    </span>
  );
}

/* ── Bulk action types ───────────────────────────────────────────────────── */

type BulkAction =
  | "retry_failed"
  | "delete_failed"
  | "delete_candidates"
  | "pause_candidates"
  | "resume_paused"
  | "queue_candidates"
  | "delete_selected";

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function PipelineMonitorPage() {
  const [status, setStatus] = useState<PipelineMonitorStatus | null>(null);
  const [trackData, setTrackData] = useState<PipelineTrackList | null>(null);
  const [statusFilter, setStatusFilter] = useState<AcquisitionStatus | "">("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [sortBy, setSortBy] = useState("updated_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [editingQuery, setEditingQuery] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [retrying, setRetrying] = useState<Set<number>>(new Set());
  const [queuing, setQueuing] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const refreshRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  /* ── Expand / detail state ───────────────────────────────────── */

  const [expandedTrackId, setExpandedTrackId] = useState<number | null>(null);
  const [expandedJobs, setExpandedJobs] = useState<PipelineJob[] | null>(null);
  const [expandedLoading, setExpandedLoading] = useState(false);
  const [detailTrack, setDetailTrack] = useState<PipelineTrack | null>(null);
  const [detailJobs, setDetailJobs] = useState<PipelineJob[] | null>(null);

  /* ── Data loading ─────────────────────────────────────────────── */

  const loadStatus = useCallback(async () => {
    try {
      const s = await fetchPipelineMonitorStatus();
      setStatus(s);
    } catch {
      // silent — LCD will show stale data
    }
  }, []);

  const loadTracks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchPipelineTracks({
        page,
        per_page: perPage,
        status: statusFilter || undefined,
        sort_by: sortBy,
        sort_dir: sortDir,
        search: search || undefined,
      });
      setTrackData(data);
      setSelected(new Set());
    } catch {
      toast.error("Failed to load pipeline tracks");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, statusFilter, sortBy, sortDir, search]);

  useEffect(() => {
    loadStatus();
    loadTracks();
  }, [loadStatus, loadTracks]);

  /* ── Realtime subscription ────────────────────────────────────── */

  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;

    async function setup() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;
      channel = supabase
        .channel("pipeline-tracks")
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "tracks",
            filter: `user_id=eq.${session.user.id}`,
          },
          (payload) => {
            const row = payload.new as Record<string, unknown>;
            if (
              ["available", "duplicate"].includes(
                row.acquisition_status as string,
              )
            )
              return;
            clearTimeout(refreshRef.current);
            refreshRef.current = setTimeout(() => {
              loadStatus();
              loadTracks();
            }, 1000);
          },
        )
        .subscribe();
    }
    setup();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Retry handler ────────────────────────────────────────────── */

  async function handleRetry(trackId: number, newSearchString?: string) {
    setRetrying((prev) => new Set(prev).add(trackId));
    try {
      await retryPipelineTrack(trackId, newSearchString);
      toast.success("Track queued for retry");
      loadStatus();
      loadTracks();
    } catch {
      toast.error("Retry failed");
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(trackId);
        return next;
      });
    }
  }

  /* ── Queue handler (single + multi) ──────────────────────────── */

  async function handleQueue(trackId: number) {
    setQueuing((prev) => new Set(prev).add(trackId));
    try {
      const result = await bulkCreateJobs([trackId]);
      if (result.created > 0) {
        toast.success("Download job created");
      } else {
        toast.info("Track already has an active job");
      }
      loadStatus();
      loadTracks();
    } catch {
      toast.error("Failed to queue track");
    } finally {
      setQueuing((prev) => {
        const next = new Set(prev);
        next.delete(trackId);
        return next;
      });
    }
  }

  async function handleQueueSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkActing(true);
    try {
      const result = await bulkCreateJobs(ids);
      toast.success(`${result.created} download job${result.created !== 1 ? "s" : ""} created`);
      loadStatus();
      loadTracks();
    } catch {
      toast.error("Failed to queue selected tracks");
    } finally {
      setBulkActing(false);
      setConfirmAction(null);
      setConfirmSelectedAction(null);
    }
  }

  async function handlePauseSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkActing(true);
    try {
      const result = await bulkPipelineAction("pause_candidates", ids);
      toast.success(`${result.updated ?? 0} track${(result.updated ?? 0) !== 1 ? "s" : ""} paused`);
      loadStatus();
      loadTracks();
    } catch {
      toast.error("Failed to pause selected tracks");
    } finally {
      setBulkActing(false);
      setConfirmSelectedAction(null);
    }
  }

  async function handleCancelSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkActing(true);
    try {
      const result = await bulkPipelineAction("delete_selected", ids);
      toast.success(`${result.deleted ?? 0} track${(result.deleted ?? 0) !== 1 ? "s" : ""} cancelled`);
      loadStatus();
      loadTracks();
    } catch {
      toast.error("Failed to cancel selected tracks");
    } finally {
      setBulkActing(false);
      setConfirmSelectedAction(null);
    }
  }

  async function handleResumeSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkActing(true);
    try {
      const result = await bulkPipelineAction("resume_paused", ids);
      toast.success(`${result.updated ?? 0} track${(result.updated ?? 0) !== 1 ? "s" : ""} resumed`);
      loadStatus();
      loadTracks();
    } catch {
      toast.error("Failed to resume selected tracks");
    } finally {
      setBulkActing(false);
      setConfirmSelectedAction(null);
    }
  }

  async function handleRetrySelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkActing(true);
    try {
      const result = await bulkPipelineAction("retry_failed", ids);
      toast.success(`${result.updated ?? 0} track${(result.updated ?? 0) !== 1 ? "s" : ""} retried`);
      loadStatus();
      loadTracks();
    } catch {
      toast.error("Failed to retry selected tracks");
    } finally {
      setBulkActing(false);
      setConfirmSelectedAction(null);
    }
  }

  /* ── Expand handler ──────────────────────────────────────────── */

  async function handleExpand(trackId: number) {
    if (expandedTrackId === trackId) {
      setExpandedTrackId(null);
      setExpandedJobs(null);
      return;
    }
    setExpandedTrackId(trackId);
    setExpandedJobs(null);
    setExpandedLoading(true);
    try {
      const data = await fetchTrackJobs(trackId);
      setExpandedJobs(data.jobs);
    } catch {
      toast.error("Failed to load job history");
      setExpandedTrackId(null);
    } finally {
      setExpandedLoading(false);
    }
  }

  /* ── Selection helpers ─────────────────────────────────────────── */

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (!trackData) return;
    const allIds = trackData.tracks.map((t) => t.id);
    const allSelected = allIds.every((id) => selected.has(id));
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allIds));
    }
  }

  const selectedCandidateCount = trackData
    ? trackData.tracks.filter(
        (t) => selected.has(t.id) && t.acquisition_status === "candidate",
      ).length
    : 0;

  const selectedPausedCount = trackData
    ? trackData.tracks.filter(
        (t) => selected.has(t.id) && t.acquisition_status === "paused",
      ).length
    : 0;

  const selectedFailedCount = trackData
    ? trackData.tracks.filter(
        (t) =>
          selected.has(t.id) &&
          (t.acquisition_status === "failed" || t.acquisition_status === "not_found"),
      ).length
    : 0;

  const selectedDeletableCount = trackData
    ? trackData.tracks.filter(
        (t) =>
          selected.has(t.id) &&
          ["candidate", "paused", "failed", "not_found"].includes(t.acquisition_status),
      ).length
    : 0;

  /* ── Bulk action state ───────────────────────────────────────── */

  const [bulkActing, setBulkActing] = useState(false);
  const [confirmAction, setConfirmAction] = useState<BulkAction | null>(null);
  const [confirmSelectedAction, setConfirmSelectedAction] = useState<
    "queue" | "pause" | "cancel" | "resume" | "retry" | null
  >(null);

  const failedCount =
    (status?.failed ?? 0) + (status?.not_found ?? 0);

  const CONFIRM_LABELS: Record<
    BulkAction,
    { title: string; desc: string; btn: string; color: string }
  > = {
    retry_failed: {
      title: "Retry All Failed",
      desc: `Reset ${failedCount} failed/not-found tracks to candidate?`,
      btn: "Retry All",
      color: "var(--led-orange)",
    },
    delete_failed: {
      title: "Delete All Failed",
      desc: `Permanently delete ${failedCount} failed/not-found tracks?`,
      btn: "Delete All",
      color: "var(--led-red)",
    },
    delete_candidates: {
      title: "Cancel All Candidates",
      desc: `Permanently delete ${status?.candidate ?? 0} candidate tracks?`,
      btn: "Delete All",
      color: "var(--led-red)",
    },
    pause_candidates: {
      title: "Pause All Candidates",
      desc: `Pause ${status?.candidate ?? 0} candidate tracks? They won't be picked up by the agent until resumed.`,
      btn: "Pause All",
      color: "var(--led-orange)",
    },
    resume_paused: {
      title: "Resume All Paused",
      desc: `Resume ${status?.paused ?? 0} paused tracks? They'll be queued as candidates for the agent to pick up.`,
      btn: "Resume All",
      color: "var(--led-green)",
    },
    queue_candidates: {
      title: "Queue Idle Candidates",
      desc: `Create download jobs for ${status?.candidate ?? 0} candidate tracks that have no active job? The agent will start processing them.`,
      btn: "Queue All",
      color: "var(--led-blue)",
    },
    delete_selected: {
      title: "Delete Selected Tracks",
      desc: `Permanently delete ${selected.size} selected track${selected.size !== 1 ? "s" : ""}?`,
      btn: "Delete",
      color: "var(--led-red)",
    },
  };

  async function handleBulkAction(action: BulkAction) {
    setBulkActing(true);
    try {
      const result = await bulkPipelineAction(action);
      const count = result.updated ?? result.deleted ?? result.created ?? 0;
      const verbs: Record<string, string> = {
        retry_failed: "retried",
        delete_failed: "deleted",
        delete_candidates: "cancelled",
        pause_candidates: "paused",
        resume_paused: "resumed",
        queue_candidates: "queued",
      };
      const verb = verbs[action] ?? "updated";
      toast.success(`${count} track${count !== 1 ? "s" : ""} ${verb}`);
      loadStatus();
      loadTracks();
    } catch {
      toast.error("Bulk action failed");
    } finally {
      setBulkActing(false);
      setConfirmAction(null);
    }
  }

  /* ── Sort handler ─────────────────────────────────────────────── */

  function handleSort(col: string) {
    if (sortBy === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortDir("desc");
    }
    setPage(1);
  }

  /* ── Derived values ───────────────────────────────────────────── */

  const totalPages = trackData
    ? Math.ceil(trackData.total / trackData.per_page)
    : 0;

  const agent = status?.agents?.[0] ?? null;

  /* ── Render ───────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* Title + Search */}
      <div className="flex items-center gap-4">
        <h1
          className="font-bold shrink-0"
          style={{
            fontSize: 28,
            fontWeight: 900,
            letterSpacing: -1,
            color: "var(--hw-text)",
          }}
        >
          Pipeline Monitor
        </h1>
        <div className="flex-1" />
        <div style={{ width: "clamp(180px, 24vw, 300px)" }}>
          <MiniSearch
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search tracks..."
          />
        </div>
      </div>

      {/* ── Realtime indicator bar ──────────────────────────────── */}
      <div
        className="flex items-center justify-between"
        style={{
          background: "var(--hw-surface)",
          border: "1px solid var(--hw-border)",
          borderRadius: 6,
          padding: "8px 14px",
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="bg-led-green"
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              display: "inline-block",
              animation: "led-pulse 1.5s infinite",
            }}
          />
          <span
            className="font-mono"
            style={{
              fontSize: 11,
              color: "var(--hw-text-dim)",
              letterSpacing: 0.5,
            }}
          >
            Realtime &middot; Supabase
          </span>
        </div>
        {agent && (
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${agentStatusColor(agent.last_seen_at)}`}
            />
            <span
              className="font-mono"
              style={{ fontSize: 11, color: "var(--hw-text-dim)" }}
            >
              {agent.machine_name}
            </span>
            <span
              className="font-mono"
              style={{ fontSize: 10, color: "var(--hw-text-muted)" }}
            >
              {relativeTime(agent.last_seen_at)}
            </span>
          </div>
        )}
      </div>

      {/* ── LCD stat bar ────────────────────────────────────────── */}
      <div className="grid grid-cols-4 md:grid-cols-7 gap-3 mb-6">
        <LCDDisplay value={status?.candidate ?? 0} label="Candidates" />
        <LCDDisplay value={status?.searching ?? 0} label="Searching" />
        <LCDDisplay value={status?.found ?? 0} label="Found" />
        <LCDDisplay value={status?.downloading ?? 0} label="Downloading" />
        <LCDDisplay value={status?.not_found ?? 0} label="Not Found" />
        <LCDDisplay value={status?.failed ?? 0} label="Failed" />
        <LCDDisplay value={status?.paused ?? 0} label="Paused" />
      </div>

      {/* ── Filter buttons ──────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 mb-4">
        {FILTER_OPTIONS.map((f) => {
          const count = f.value
            ? (status?.[f.value] ?? 0)
            : Object.values(status ?? {}).reduce(
                (a, v) => a + (typeof v === "number" ? v : 0),
                0,
              );
          const isActive = statusFilter === f.value;
          return (
            <button
              key={f.value}
              onClick={() => {
                setStatusFilter(f.value as AcquisitionStatus | "");
                setPage(1);
              }}
              className="font-mono uppercase"
              style={{
                fontSize: 11,
                padding: "6px 14px",
                borderRadius: 4,
                border: isActive
                  ? "1px solid var(--led-orange)"
                  : "1px solid #333",
                background: isActive
                  ? "rgba(255, 160, 51, 0.08)"
                  : "var(--hw-surface)",
                color: isActive
                  ? "var(--hw-lcd-text)"
                  : "var(--hw-text-dim)",
                letterSpacing: 0.5,
                cursor: "pointer",
              }}
            >
              {f.label} ({count})
            </button>
          );
        })}
      </div>

      {/* ── Bulk action toolbar ─────────────────────────────────── */}
      {(failedCount > 0 ||
        (status?.candidate ?? 0) > 0 ||
        (status?.paused ?? 0) > 0) && (
        <div
          className="flex flex-wrap items-center gap-2"
          style={{
            background: "var(--hw-surface)",
            border: "1px solid var(--hw-border)",
            borderRadius: 6,
            padding: "8px 14px",
          }}
        >
          <span
            className="font-mono uppercase"
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: "var(--hw-text-muted)",
              letterSpacing: 1,
              marginRight: 8,
            }}
          >
            Bulk Actions
          </span>
          {failedCount > 0 && (
            <>
              <BulkBtn
                label={`Retry All Failed (${failedCount})`}
                color="var(--led-orange)"
                onClick={() => setConfirmAction("retry_failed")}
              />
              <BulkBtn
                label={`Delete All Failed (${failedCount})`}
                color="var(--led-red)"
                onClick={() => setConfirmAction("delete_failed")}
              />
            </>
          )}
          {(status?.candidate ?? 0) > 0 && (
            <>
              <BulkBtn
                label={`Queue Idle Candidates (${status?.candidate ?? 0})`}
                color="var(--led-blue)"
                onClick={() => setConfirmAction("queue_candidates")}
              />
              <BulkBtn
                label={`Pause Candidates (${status?.candidate ?? 0})`}
                color="var(--led-orange)"
                onClick={() => setConfirmAction("pause_candidates")}
              />
              <BulkBtn
                label={`Cancel Candidates (${status?.candidate ?? 0})`}
                color="var(--led-red)"
                onClick={() => setConfirmAction("delete_candidates")}
              />
            </>
          )}
          {(status?.paused ?? 0) > 0 && (
            <BulkBtn
              label={`Resume Paused (${status?.paused ?? 0})`}
              color="var(--led-green)"
              onClick={() => setConfirmAction("resume_paused")}
            />
          )}
        </div>
      )}

      {/* ── Confirm dialog overlay ────────────────────────────── */}
      {confirmAction && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.6)",
          }}
          onClick={() => !bulkActing && setConfirmAction(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--hw-surface)",
              border: "1px solid var(--hw-border)",
              borderRadius: 8,
              padding: "24px 28px",
              maxWidth: 400,
              width: "90vw",
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
            }}
          >
            <h3
              className="font-mono"
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "var(--hw-text)",
                marginBottom: 8,
              }}
            >
              {CONFIRM_LABELS[confirmAction].title}
            </h3>
            <p
              style={{
                fontSize: 13,
                color: "var(--hw-text-dim)",
                marginBottom: 20,
                lineHeight: 1.5,
              }}
            >
              {CONFIRM_LABELS[confirmAction].desc}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmAction(null)}
                disabled={bulkActing}
                className="font-mono"
                style={{
                  fontSize: 12,
                  padding: "6px 16px",
                  borderRadius: 4,
                  border: "1px solid var(--hw-border)",
                  background: "transparent",
                  color: "var(--hw-text-dim)",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleBulkAction(confirmAction)}
                disabled={bulkActing}
                className="font-mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  padding: "6px 16px",
                  borderRadius: 4,
                  border: `1px solid ${CONFIRM_LABELS[confirmAction].color}`,
                  background: `color-mix(in srgb, ${CONFIRM_LABELS[confirmAction].color} 15%, transparent)`,
                  color: CONFIRM_LABELS[confirmAction].color,
                  cursor: bulkActing ? "not-allowed" : "pointer",
                  opacity: bulkActing ? 0.6 : 1,
                }}
              >
                {bulkActing ? "..." : CONFIRM_LABELS[confirmAction].btn}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Selection action bar (above table, sticky) ────────── */}
      {selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-3 sticky top-0 z-10"
          style={{
            background: "color-mix(in srgb, var(--led-blue) 6%, var(--hw-surface))",
            border: "1px solid color-mix(in srgb, var(--led-blue) 25%, transparent)",
            borderRadius: 6,
            padding: "8px 14px",
          }}
        >
          <span
            className="font-mono"
            style={{ fontSize: 11, fontWeight: 700, color: "var(--led-blue)" }}
          >
            {selected.size} selected
          </span>
          {selectedCandidateCount > 0 && (
            <BulkBtn
              label={`Queue ${selectedCandidateCount} Candidate${selectedCandidateCount !== 1 ? "s" : ""}`}
              color="var(--led-blue)"
              onClick={() => setConfirmSelectedAction("queue")}
            />
          )}
          {selectedCandidateCount > 0 && (
            <BulkBtn
              label={`Pause ${selectedCandidateCount} Candidate${selectedCandidateCount !== 1 ? "s" : ""}`}
              color="var(--led-orange)"
              onClick={() => setConfirmSelectedAction("pause")}
            />
          )}
          {selectedPausedCount > 0 && (
            <BulkBtn
              label={`Resume ${selectedPausedCount} Paused`}
              color="var(--led-green)"
              onClick={() => setConfirmSelectedAction("resume")}
            />
          )}
          {selectedFailedCount > 0 && (
            <BulkBtn
              label={`Retry ${selectedFailedCount} Failed`}
              color="var(--led-orange)"
              onClick={() => setConfirmSelectedAction("retry")}
            />
          )}
          {selectedDeletableCount > 0 && (
            <BulkBtn
              label={`Cancel ${selectedDeletableCount} Track${selectedDeletableCount !== 1 ? "s" : ""}`}
              color="var(--led-red)"
              onClick={() => setConfirmSelectedAction("cancel")}
            />
          )}
          <button
            onClick={() => setSelected(new Set())}
            className="font-mono"
            style={{
              fontSize: 10,
              color: "var(--hw-text-dim)",
              background: "none",
              border: "none",
              cursor: "pointer",
              marginLeft: "auto",
            }}
          >
            Clear selection
          </button>
        </div>
      )}

      {/* ── Confirm selected action dialog ─────────────────────── */}
      {confirmSelectedAction && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.6)",
          }}
          onClick={() => !bulkActing && setConfirmSelectedAction(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--hw-surface)",
              border: "1px solid var(--hw-border)",
              borderRadius: 8,
              padding: "24px 28px",
              maxWidth: 400,
              width: "90vw",
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
            }}
          >
            <h3
              className="font-mono"
              style={{ fontSize: 14, fontWeight: 700, color: "var(--hw-text)", marginBottom: 8 }}
            >
              {{
                queue: "Queue Selected Candidates",
                pause: "Pause Selected Candidates",
                cancel: "Cancel Selected Tracks",
                resume: "Resume Selected Paused",
                retry: "Retry Selected Failed",
              }[confirmSelectedAction]}
            </h3>
            <p style={{ fontSize: 13, color: "var(--hw-text-dim)", marginBottom: 20, lineHeight: 1.5 }}>
              {{
                queue: `Create download jobs for ${selectedCandidateCount} selected candidate${selectedCandidateCount !== 1 ? "s" : ""}?`,
                pause: `Pause ${selectedCandidateCount} selected candidate${selectedCandidateCount !== 1 ? "s" : ""}? They won\u2019t be picked up by the agent until resumed.`,
                cancel: `Permanently delete ${selectedDeletableCount} selected track${selectedDeletableCount !== 1 ? "s" : ""}?`,
                resume: `Resume ${selectedPausedCount} selected paused track${selectedPausedCount !== 1 ? "s" : ""}?`,
                retry: `Retry ${selectedFailedCount} selected failed track${selectedFailedCount !== 1 ? "s" : ""}? They\u2019ll be reset to candidate.`,
              }[confirmSelectedAction]}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmSelectedAction(null)}
                disabled={bulkActing}
                className="font-mono"
                style={{
                  fontSize: 12, padding: "6px 16px", borderRadius: 4,
                  border: "1px solid var(--hw-border)", background: "transparent",
                  color: "var(--hw-text-dim)", cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const handlers = {
                    queue: handleQueueSelected,
                    pause: handlePauseSelected,
                    cancel: handleCancelSelected,
                    resume: handleResumeSelected,
                    retry: handleRetrySelected,
                  };
                  handlers[confirmSelectedAction]();
                }}
                disabled={bulkActing}
                className="font-mono"
                style={{
                  fontSize: 12, fontWeight: 700, padding: "6px 16px", borderRadius: 4,
                  border: `1px solid ${{ queue: "var(--led-blue)", pause: "var(--led-orange)", cancel: "var(--led-red)", resume: "var(--led-green)", retry: "var(--led-orange)" }[confirmSelectedAction]}`,
                  background: `color-mix(in srgb, ${{ queue: "var(--led-blue)", pause: "var(--led-orange)", cancel: "var(--led-red)", resume: "var(--led-green)", retry: "var(--led-orange)" }[confirmSelectedAction]} 15%, transparent)`,
                  color: { queue: "var(--led-blue)", pause: "var(--led-orange)", cancel: "var(--led-red)", resume: "var(--led-green)", retry: "var(--led-orange)" }[confirmSelectedAction],
                  cursor: bulkActing ? "not-allowed" : "pointer",
                  opacity: bulkActing ? 0.6 : 1,
                }}
              >
                {bulkActing ? "..." : { queue: "Queue", pause: "Pause", cancel: "Delete", resume: "Resume", retry: "Retry" }[confirmSelectedAction]}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Track table ─────────────────────────────────────────── */}
      <div
        className="rounded-md overflow-hidden"
        style={{
          background: "var(--hw-list-bg, var(--hw-surface))",
          border: "1.5px solid var(--hw-list-border, var(--hw-border))",
          boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
        }}
      >
        {/* Table header */}
        <div
          className="hidden md:grid items-center gap-3 px-4 py-2.5"
          style={{
            gridTemplateColumns: "28px 44px 1fr 120px 1fr 80px 80px 80px",
            borderBottom:
              "1px solid var(--hw-list-border, var(--hw-border))",
            background: "var(--hw-list-header, var(--hw-surface))",
          }}
        >
          {/* Select all checkbox */}
          <input
            type="checkbox"
            checked={
              !!trackData &&
              trackData.tracks.length > 0 &&
              trackData.tracks.every((t) => selected.has(t.id))
            }
            onChange={toggleSelectAll}
            style={{ width: 14, height: 14, cursor: "pointer", accentColor: "var(--led-blue)" }}
          />
          {/* Artwork spacer */}
          <span />
          {/* Track */}
          <button
            onClick={() => handleSort("title")}
            className="font-mono uppercase text-left"
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: "var(--hw-text-muted)",
              letterSpacing: 1,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Track
            <SortArrow column="title" sortBy={sortBy} sortDir={sortDir} />
          </button>
          {/* Status */}
          <button
            onClick={() => handleSort("acquisition_status")}
            className="font-mono uppercase text-left"
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: "var(--hw-text-muted)",
              letterSpacing: 1,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Status
            <SortArrow
              column="acquisition_status"
              sortBy={sortBy}
              sortDir={sortDir}
            />
          </button>
          {/* Search Query */}
          <button
            onClick={() => handleSort("search_string")}
            className="font-mono uppercase text-left"
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: "var(--hw-text-muted)",
              letterSpacing: 1,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Search Query
            <SortArrow
              column="search_string"
              sortBy={sortBy}
              sortDir={sortDir}
            />
          </button>
          {/* Results */}
          <button
            onClick={() => handleSort("search_results_count")}
            className="font-mono uppercase text-left"
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: "var(--hw-text-muted)",
              letterSpacing: 1,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Results
            <SortArrow
              column="search_results_count"
              sortBy={sortBy}
              sortDir={sortDir}
            />
          </button>
          {/* Added */}
          <button
            onClick={() => handleSort("created_at")}
            className="font-mono uppercase text-left"
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: "var(--hw-text-muted)",
              letterSpacing: 1,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Added
            <SortArrow
              column="created_at"
              sortBy={sortBy}
              sortDir={sortDir}
            />
          </button>
          {/* Actions */}
          <span
            className="font-mono uppercase text-left"
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: "var(--hw-text-muted)",
              letterSpacing: 1,
            }}
          >
            Actions
          </span>
        </div>

        {/* Table body */}
        {loading && !trackData ? (
          <div style={{ padding: "40px 20px", textAlign: "center" }}>
            <span
              className="font-mono"
              style={{ fontSize: 13, color: "var(--hw-text-dim)" }}
            >
              Loading...
            </span>
          </div>
        ) : !trackData || trackData.tracks.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center" }}>
            <span style={{ fontSize: 14, color: "var(--hw-text-dim)" }}>
              No tracks found.
            </span>
          </div>
        ) : (
          trackData.tracks.map((track) => (
            <div key={track.id}>
              <TrackRow
                track={track}
                editingQuery={editingQuery}
                editValue={editValue}
                retrying={retrying.has(track.id)}
                queuing={queuing.has(track.id)}
                isSelected={selected.has(track.id)}
                isExpanded={expandedTrackId === track.id}
                onToggleSelect={() => toggleSelect(track.id)}
                onExpand={() => handleExpand(track.id)}
                onEditStart={(id, val) => {
                  setEditingQuery(id);
                  setEditValue(val);
                }}
                onEditChange={setEditValue}
                onEditCancel={() => setEditingQuery(null)}
                onEditSubmit={(id) => {
                  handleRetry(id, editValue);
                  setEditingQuery(null);
                }}
                onRetry={(id) => handleRetry(id)}
                onQueue={(id) => handleQueue(id)}
              />
              {/* Expansion panel */}
              {expandedTrackId === track.id && (
                <div
                  style={{
                    borderBottom: "1px solid var(--hw-list-border, var(--hw-border))",
                    background: "color-mix(in srgb, var(--led-blue) 3%, var(--hw-list-row-bg, var(--hw-surface)))",
                  }}
                >
                  {expandedLoading ? (
                    <div style={{ padding: "10px 16px 10px 88px" }}>
                      <span className="font-mono" style={{ fontSize: 11, color: "var(--hw-text-muted)" }}>
                        Loading job history...
                      </span>
                    </div>
                  ) : expandedJobs ? (
                    <JobChainStrip
                      jobs={expandedJobs}
                      source={track.source}
                      onViewDetails={() => {
                        setDetailTrack(track);
                        setDetailJobs(expandedJobs);
                      }}
                    />
                  ) : null}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* ── Pagination ──────────────────────────────────────────── */}
      {trackData && totalPages > 0 && (
        <div
          className="flex items-center justify-between font-mono"
          style={{ fontSize: 12, color: "var(--hw-text-dim)" }}
        >
          <span>
            Page {trackData.page} of {totalPages} ({trackData.total} tracks)
          </span>
          <div className="flex items-center gap-3">
            {/* Per-page selector */}
            <div className="flex items-center gap-1.5">
              <span style={{ fontSize: 11, color: "var(--hw-text-muted)" }}>
                Show
              </span>
              {[25, 50, 100].map((n) => (
                <button
                  key={n}
                  onClick={() => {
                    setPerPage(n);
                    setPage(1);
                  }}
                  style={{
                    fontSize: 11,
                    padding: "3px 8px",
                    borderRadius: 3,
                    border:
                      perPage === n
                        ? "1px solid var(--led-orange)"
                        : "1px solid var(--hw-border)",
                    background:
                      perPage === n
                        ? "rgba(255, 160, 51, 0.08)"
                        : "transparent",
                    color:
                      perPage === n
                        ? "var(--hw-lcd-text)"
                        : "var(--hw-text-dim)",
                    cursor: "pointer",
                  }}
                >
                  {n}
                </button>
              ))}
            </div>

            {/* Prev / Next */}
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
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
                  setPage((p) => Math.min(totalPages, p + 1))
                }
                disabled={page >= totalPages}
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
        </div>
      )}

      {/* ── Detail panel ────────────────────────────────────────── */}
      {detailTrack && detailJobs && (
        <PipelineDetailPanel
          track={detailTrack}
          jobs={detailJobs}
          onClose={() => {
            setDetailTrack(null);
            setDetailJobs(null);
          }}
        />
      )}
    </div>
  );
}

/* ── BulkBtn ─────────────────────────────────────────────────────────────── */

function BulkBtn({
  label,
  color,
  onClick,
}: {
  label: string;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="font-mono uppercase"
      style={{
        fontSize: 10,
        fontWeight: 700,
        padding: "5px 12px",
        borderRadius: 4,
        border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        color,
        cursor: "pointer",
        letterSpacing: 0.5,
      }}
    >
      {label}
    </button>
  );
}

/* ── TrackRow ─────────────────────────────────────────────────────────────── */

function TrackRow({
  track,
  editingQuery,
  editValue,
  retrying,
  queuing,
  isSelected,
  isExpanded,
  onToggleSelect,
  onExpand,
  onEditStart,
  onEditChange,
  onEditCancel,
  onEditSubmit,
  onRetry,
  onQueue,
}: {
  track: PipelineTrack;
  editingQuery: number | null;
  editValue: string;
  retrying: boolean;
  queuing: boolean;
  isSelected: boolean;
  isExpanded: boolean;
  onToggleSelect: () => void;
  onExpand: () => void;
  onEditStart: (id: number, val: string) => void;
  onEditChange: (val: string) => void;
  onEditCancel: () => void;
  onEditSubmit: (id: number) => void;
  onRetry: (id: number) => void;
  onQueue: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isEditing = editingQuery === track.id;
  const canRetry =
    track.acquisition_status === "not_found" ||
    track.acquisition_status === "failed";
  const canQueue = track.acquisition_status === "candidate";
  const resultsCount = track.search_results_count;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="grid items-center gap-3 px-4"
      style={{
        gridTemplateColumns: "28px 44px 1fr 120px 1fr 80px 80px 80px",
        padding: "10px 16px",
        borderBottom: isExpanded
          ? "none"
          : "1px solid var(--hw-list-border, var(--hw-border))",
        background: isSelected
          ? "color-mix(in srgb, var(--led-blue) 6%, var(--hw-list-row-bg, var(--hw-surface)))"
          : hovered
            ? "var(--hw-list-row-hover, var(--hw-raised))"
            : "var(--hw-list-row-bg, var(--hw-surface))",
        transition: "background 0.15s ease",
      }}
    >
      {/* Checkbox */}
      <input
        type="checkbox"
        checked={isSelected}
        onChange={onToggleSelect}
        style={{ width: 14, height: 14, cursor: "pointer", accentColor: "var(--led-blue)" }}
      />
      {/* Artwork */}
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 4,
          overflow: "hidden",
          background: "var(--hw-raised)",
          flexShrink: 0,
        }}
      >
        {track.artwork_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={track.artwork_url}
            alt=""
            width={40}
            height={40}
            style={{ objectFit: "cover", width: 40, height: 40 }}
          />
        ) : (
          <div
            style={{
              width: 40,
              height: 40,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--hw-text-muted)"
              strokeWidth="1.2"
            >
              <circle cx="8" cy="8" r="6" />
              <circle cx="8" cy="8" r="2" />
            </svg>
          </div>
        )}
      </div>

      {/* Track info — click to expand */}
      <div
        className="min-w-0 cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          onExpand();
        }}
      >
        <div
          className="truncate text-sm"
          style={{ fontWeight: 600, color: "var(--hw-text)" }}
        >
          {track.title}
        </div>
        <div
          className="truncate text-xs"
          style={{ color: "var(--hw-text-dim)" }}
        >
          {track.artist}
          {track.album && (
            <span style={{ color: "var(--hw-text-muted)" }}>
              {" "}
              &middot; {track.album}
            </span>
          )}
        </div>
      </div>

      {/* Status */}
      <StatusBadge status={track.acquisition_status} />

      {/* Search query */}
      <div className="min-w-0">
        {isEditing ? (
          <input
            autoFocus
            value={editValue}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEditSubmit(track.id);
              if (e.key === "Escape") onEditCancel();
            }}
            className="font-mono w-full"
            style={{
              fontSize: 11,
              padding: "4px 8px",
              borderRadius: 4,
              border: "1px solid var(--led-orange)",
              background: "var(--hw-input-bg)",
              color: "var(--hw-lcd-text)",
              outline: "none",
            }}
          />
        ) : (
          <span
            className="font-mono truncate block"
            style={{
              fontSize: 11,
              color: "var(--hw-text-dim)",
              cursor:
                track.acquisition_status === "not_found"
                  ? "pointer"
                  : "default",
            }}
            title={track.search_string ?? undefined}
            onClick={() => {
              if (track.acquisition_status === "not_found") {
                onEditStart(track.id, track.search_string ?? "");
              }
            }}
          >
            {track.search_string ?? "\u2014"}
          </span>
        )}
      </div>

      {/* Results count */}
      <span
        className="font-mono"
        style={{
          fontSize: 12,
          fontWeight: 700,
          color:
            resultsCount === null || resultsCount === undefined
              ? "var(--hw-text-muted)"
              : resultsCount > 0
                ? "var(--led-green)"
                : "var(--led-red)",
        }}
      >
        {resultsCount === null || resultsCount === undefined
          ? "\u2014"
          : resultsCount}
      </span>

      {/* Added date */}
      <span
        className="font-mono"
        style={{ fontSize: 10, color: "var(--hw-text-muted)" }}
      >
        {track.created_at
          ? new Date(track.created_at).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "2-digit",
            })
          : ""}
      </span>

      {/* Actions */}
      <div className="flex gap-1.5">
        {canQueue && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onQueue(track.id);
            }}
            disabled={queuing}
            className="font-mono shrink-0 transition-colors duration-150 disabled:opacity-50"
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: queuing ? "var(--hw-text-muted)" : "var(--led-blue)",
              background: "transparent",
              border: "1px solid color-mix(in srgb, var(--led-blue) 40%, transparent)",
              padding: "3px 10px",
              borderRadius: 4,
              cursor: queuing ? "not-allowed" : "pointer",
            }}
            title="Create download job for this track"
          >
            {queuing ? "..." : "Queue"}
          </button>
        )}
        {canRetry && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRetry(track.id);
            }}
            disabled={retrying}
            className="font-mono shrink-0 transition-colors duration-150 disabled:opacity-50"
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: retrying ? "var(--hw-text-muted)" : "var(--hw-text-dim)",
              background: "transparent",
              border:
                "1px solid var(--hw-list-border, var(--hw-border))",
              padding: "3px 10px",
              borderRadius: 4,
              cursor: retrying ? "not-allowed" : "pointer",
            }}
            title="Retry this track"
          >
            {retrying ? "..." : "Retry"}
          </button>
        )}
      </div>
    </div>
  );
}
