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
          ))
        )}
      </div>

      {/* ── Selection action bar ─────────────────────────────────── */}
      {selected.size > 0 && (
        <div
          className="flex items-center gap-3"
          style={{
            background: "color-mix(in srgb, var(--led-blue) 6%, transparent)",
            border: "1px solid color-mix(in srgb, var(--led-blue) 25%, transparent)",
            borderRadius: 6,
            padding: "8px 14px",
          }}
        >
          <span
            className="font-mono"
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--led-blue)",
            }}
          >
            {selected.size} selected
          </span>
          {selectedCandidateCount > 0 && (
            <BulkBtn
              label={`Queue ${selectedCandidateCount} Candidate${selectedCandidateCount !== 1 ? "s" : ""}`}
              color="var(--led-blue)"
              onClick={handleQueueSelected}
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
        borderBottom:
          "1px solid var(--hw-list-border, var(--hw-border))",
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
