// web/components/folder-import/DuplicateReview.tsx
"use client";

import { useState } from "react";
import { reviewDuplicates, type ReviewDecision } from "@/lib/api";
import ActionButton from "@/components/ui/ActionButton";

interface PendingTrack {
  id: number;
  title: string;
  artist: string;
  local_path: string;
  extension: string;
  size_display: string;
  duplicate_track_id: number;
  duplicate_title: string;
  duplicate_artist: string;
  duplicate_extension: string;
  duplicate_size_display: string;
  duplicate_enriched: boolean;
  duplicate_has_art: boolean;
  duplicate_in_library: boolean;
  confidence: number;
}

interface DuplicateReviewProps {
  pendingTracks: PendingTrack[];
  importedCount: number;
  processingCount: number;
  onDecisionsComplete: () => void;
}

function MetaTag({
  label,
  green = false,
}: {
  label: string;
  green?: boolean;
}) {
  return (
    <span
      className="font-mono"
      style={{
        display: "inline-block",
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase",
        padding: "2px 7px",
        borderRadius: 3,
        background: green ? "rgba(68,255,68,0.08)" : "var(--hw-border-light)",
        color: green ? "var(--led-green-on)" : "var(--hw-text-muted)",
        border: green
          ? "1px solid rgba(68,255,68,0.2)"
          : "1px solid var(--hw-border)",
      }}
    >
      {label}
    </span>
  );
}

function CardActionButton({
  children,
  variant,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  variant: "success" | "outline" | "danger";
  onClick: () => void;
  disabled?: boolean;
}) {
  const [hovered, setHovered] = useState(false);

  const variantStyles: React.CSSProperties =
    variant === "success"
      ? {
          background: hovered ? "rgba(68,255,68,0.18)" : "rgba(68,255,68,0.08)",
          color: hovered ? "var(--led-green-on)" : "#44CC44",
          border: `1px solid ${hovered ? "var(--led-green-on)" : "rgba(68,255,68,0.3)"}`,
          boxShadow: hovered ? "0 0 10px rgba(68,255,68,0.2)" : "none",
        }
      : variant === "danger"
        ? {
            background: hovered ? "rgba(255,68,68,0.18)" : "rgba(255,68,68,0.08)",
            color: hovered ? "#FF6666" : "#CC4444",
            border: `1px solid ${hovered ? "#FF6666" : "rgba(255,68,68,0.3)"}`,
            boxShadow: hovered ? "0 0 10px rgba(255,68,68,0.2)" : "none",
          }
        : {
            background: hovered ? "var(--hw-raised)" : "transparent",
            color: hovered ? "var(--hw-text)" : "var(--hw-text-muted)",
            border: `1px solid ${hovered ? "var(--hw-border-light)" : "var(--hw-border)"}`,
            boxShadow: "none",
          };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="font-mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 14px",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1.2,
        textTransform: "uppercase",
        borderRadius: 4,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "all 0.15s",
        ...variantStyles,
      }}
    >
      {children}
    </button>
  );
}

export function DuplicateReview({
  pendingTracks,
  importedCount,
  processingCount,
  onDecisionsComplete,
}: DuplicateReviewProps) {
  const [remaining, setRemaining] = useState(pendingTracks);
  const [submitting, setSubmitting] = useState(false);

  const handleAction = async (
    track: PendingTrack,
    action: "keep" | "skip" | "replace",
  ) => {
    setSubmitting(true);
    try {
      const decision: ReviewDecision = {
        track_id: track.id,
        action,
        ...(action === "replace" ? { duplicate_track_id: track.duplicate_track_id } : {}),
      };
      await reviewDuplicates([decision]);
      const next = remaining.filter((t) => t.id !== track.id);
      setRemaining(next);
      if (next.length === 0) onDecisionsComplete();
    } finally {
      setSubmitting(false);
    }
  };

  const handleBatchAction = async (action: "keep" | "skip") => {
    setSubmitting(true);
    try {
      const decisions: ReviewDecision[] = remaining.map((t) => ({
        track_id: t.id,
        action,
      }));
      await reviewDuplicates(decisions);
      setRemaining([]);
      onDecisionsComplete();
    } finally {
      setSubmitting(false);
    }
  };

  const getFilename = (path: string) => path.split("/").pop() ?? path;

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
        {[
          { label: "Imported", value: importedCount },
          { label: "Processing", value: processingCount },
          {
            label: "Need Review",
            value: remaining.length,
            highlight: true,
          },
        ].map((item, i, arr) => (
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
                color: item.highlight
                  ? "var(--led-orange-on)"
                  : "var(--hw-lcd-text)",
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
                color: item.highlight
                  ? "var(--led-orange-on)"
                  : "var(--hw-text-muted)",
                marginTop: 4,
                opacity: item.highlight ? 0.8 : 0.6,
              }}
            >
              {item.label}
            </div>
          </div>
        ))}
      </div>

      {/* Batch Actions Bar */}
      {remaining.length > 1 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--hw-surface)",
            border: "1px solid var(--hw-border-light)",
            borderRadius: 6,
            padding: "10px 16px",
          }}
        >
          <span
            className="font-mono"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              color: "var(--hw-text-muted)",
            }}
          >
            Pending Decisions
            <span
              style={{
                marginLeft: 8,
                color: "var(--led-orange-on)",
              }}
            >
              {remaining.length}
            </span>
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <ActionButton
              variant="ghost"
              disabled={submitting}
              onClick={() => handleBatchAction("skip")}
            >
              Skip All
            </ActionButton>
            <ActionButton
              variant="outline"
              disabled={submitting}
              onClick={() => handleBatchAction("keep")}
            >
              Keep All
            </ActionButton>
          </div>
        </div>
      )}

      {/* Review Cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {remaining.map((track) => (
          <div
            key={track.id}
            style={{
              background: "var(--hw-surface)",
              border: "1px solid var(--hw-border-light)",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {/* Card Header */}
            <div
              style={{
                padding: "10px 16px",
                borderBottom: "1px solid var(--hw-border)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--led-orange-on)",
                  boxShadow: "0 0 6px var(--led-orange-on)",
                  flexShrink: 0,
                }}
              />
              <span
                className="font-mono"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 1.5,
                  textTransform: "uppercase",
                  color: "var(--led-orange-on)",
                }}
              >
                Fingerprint Match
              </span>
              <span
                className="font-mono"
                style={{
                  fontSize: 10,
                  color: "var(--hw-text-muted)",
                  letterSpacing: 0.5,
                }}
              >
                &middot;
              </span>
              <span
                className="font-mono"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 1,
                  color: "var(--hw-text-secondary)",
                }}
              >
                {Math.round(track.confidence * 100)}% confidence
              </span>
            </div>

            {/* Card Body — two columns with VS divider */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto 1fr",
                gap: 0,
                padding: "16px",
              }}
            >
              {/* Left: New Track */}
              <div style={{ paddingRight: 16 }}>
                <div
                  className="font-mono"
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: 2,
                    textTransform: "uppercase",
                    color: "var(--hw-text-dim)",
                    marginBottom: 8,
                  }}
                >
                  New Track (from import)
                </div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--hw-text)",
                    marginBottom: 3,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {track.title}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--hw-text-secondary)",
                    marginBottom: 10,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {track.artist}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  <MetaTag label={track.extension.toUpperCase()} />
                  {track.size_display && (
                    <MetaTag label={track.size_display} />
                  )}
                  <MetaTag
                    label={getFilename(track.local_path)}
                  />
                </div>
              </div>

              {/* VS Divider */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "0 12px",
                  gap: 6,
                  minWidth: 40,
                }}
              >
                <div
                  style={{
                    width: 1,
                    flex: 1,
                    background: "var(--hw-border)",
                  }}
                />
                <span
                  className="font-mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 2,
                    color: "var(--hw-text-muted)",
                    textTransform: "uppercase",
                  }}
                >
                  VS
                </span>
                <div
                  style={{
                    width: 1,
                    flex: 1,
                    background: "var(--hw-border)",
                  }}
                />
              </div>

              {/* Right: Existing Track */}
              <div style={{ paddingLeft: 16 }}>
                <div
                  className="font-mono"
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: 2,
                    textTransform: "uppercase",
                    color: "var(--hw-text-dim)",
                    marginBottom: 8,
                  }}
                >
                  Existing Track (in catalogue)
                </div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--hw-text)",
                    marginBottom: 3,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {track.duplicate_title}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--hw-text-secondary)",
                    marginBottom: 10,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {track.duplicate_artist}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  <MetaTag label={track.duplicate_extension.toUpperCase()} />
                  {track.duplicate_size_display && (
                    <MetaTag label={track.duplicate_size_display} />
                  )}
                  {track.duplicate_enriched && (
                    <MetaTag label="Enriched" green />
                  )}
                  {track.duplicate_has_art && (
                    <MetaTag label="Cover Art" green />
                  )}
                  {track.duplicate_in_library && (
                    <MetaTag label="In Library" green />
                  )}
                </div>
              </div>
            </div>

            {/* Card Actions */}
            <div
              style={{
                padding: "12px 16px",
                borderTop: "1px solid var(--hw-border)",
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
              }}
            >
              <CardActionButton
                variant="success"
                disabled={submitting}
                onClick={() => handleAction(track, "keep")}
              >
                Keep Both
              </CardActionButton>
              <CardActionButton
                variant="outline"
                disabled={submitting}
                onClick={() => handleAction(track, "skip")}
              >
                Skip New
              </CardActionButton>
              <CardActionButton
                variant="danger"
                disabled={submitting}
                onClick={() => handleAction(track, "replace")}
              >
                Replace Existing
              </CardActionButton>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
