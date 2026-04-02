"use client";

import { useEffect, useCallback } from "react";
import { LED_COLORS, HARDWARE, FONTS } from "@/lib/design-system/tokens";

interface DetailPanelTrack {
  id: number;
  title: string;
  artist: string;
  album?: string;
  bpm?: number;
  key?: string;
  genre?: string;
  energy?: number;
  status?: string;
  artwork_url?: string;
  local_path?: string;
  enriched_audio?: boolean;
  cover_art_written?: boolean;
}

interface DetailPanelProps {
  track: DetailPanelTrack;
  onClose: () => void;
  onAnalyze?: (trackId: number) => void;
}

export default function DetailPanel({ track: t, onClose, onAnalyze }: DetailPanelProps) {
  const c = LED_COLORS.blue;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const metadataRows: { label: string; value: string | number | undefined }[] =
    [
      { label: "Album", value: t.album },
      { label: "BPM", value: t.bpm },
      { label: "Key", value: t.key },
      { label: "Genre", value: t.genre },
      { label: "Status", value: t.status },
      {
        label: "Energy",
        value: t.energy != null ? `${Math.round(t.energy * 100)}%` : undefined,
      },
      { label: "Path", value: t.local_path },
    ];

  return (
    <>
      {/* Backdrop overlay */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.25)",
          zIndex: 59,
        }}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Details for ${t.title}`}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          width: 380,
          height: "100vh",
          background: HARDWARE.surface,
          borderLeft: `1px solid ${HARDWARE.borderLight}`,
          zIndex: 60,
          overflow: "auto",
          boxShadow: "-4px 0 24px rgba(0,0,0,0.15)",
          animation: "detailPanelSlideIn 0.25s ease",
        }}
      >
        <style>{`
          @keyframes detailPanelSlideIn {
            from { transform: translateX(100%); }
            to   { transform: translateX(0); }
          }
        `}</style>

        <div style={{ padding: 20 }}>
          {/* Header */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 16,
            }}
          >
            <span
              style={{
                fontFamily: FONTS.mono,
                fontSize: 10,
                color: c.on,
                letterSpacing: 1.5,
                fontWeight: 700,
              }}
            >
              TRACK DETAIL
            </span>
            <button
              onClick={onClose}
              aria-label="Close detail panel"
              style={{
                fontFamily: FONTS.sans,
                fontSize: 13,
                color: HARDWARE.textDim,
                cursor: "pointer",
                background: "none",
                border: "none",
                padding: 0,
              }}
            >
              &#10005; Close
            </button>
          </div>

          {/* Artwork or gradient placeholder */}
          <div
            style={{
              height: 180,
              borderRadius: 8,
              marginBottom: 16,
              position: "relative",
              overflow: "hidden",
              ...(t.artwork_url
                ? {
                    backgroundImage: `url(${t.artwork_url})`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                  }
                : {
                    background: `linear-gradient(135deg, ${c.on}55 0%, ${c.dim}22 100%)`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }),
            }}
          >
            {!t.artwork_url && (
              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 52,
                  fontWeight: 900,
                  color: `${c.on}66`,
                }}
              >
                {t.artist.slice(0, 2).toUpperCase()}
              </span>
            )}
          </div>

          {/* Title + Artist */}
          <h3
            style={{
              fontFamily: FONTS.sans,
              fontSize: 22,
              fontWeight: 900,
              letterSpacing: -0.5,
              marginBottom: 4,
              lineHeight: 1.2,
              color: HARDWARE.text,
            }}
          >
            {t.title}
          </h3>
          <p
            style={{
              fontFamily: FONTS.sans,
              fontSize: 15,
              color: HARDWARE.textSec,
              marginBottom: 20,
            }}
          >
            {t.artist}
          </p>

          {/* Metadata rows */}
          {metadataRows.map((r) =>
            r.value != null ? (
              <div
                key={r.label}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px 0",
                  borderBottom: `1px solid ${HARDWARE.border}`,
                }}
              >
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 10,
                    color: HARDWARE.textDim,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                    fontWeight: 700,
                  }}
                >
                  {r.label}
                </span>
                <span
                  style={{
                    fontFamily: r.label === "Path" ? FONTS.mono : FONTS.sans,
                    fontSize: r.label === "Path" ? 10 : 13,
                    color: HARDWARE.text,
                    textAlign: "right",
                    maxWidth: 200,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.value}
                </span>
              </div>
            ) : null
          )}

          {/* Analysis status */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "8px 0",
              borderBottom: `1px solid ${HARDWARE.border}`,
            }}
          >
            <span
              style={{
                fontFamily: FONTS.mono,
                fontSize: 10,
                color: HARDWARE.textDim,
                letterSpacing: 1,
                textTransform: "uppercase",
                fontWeight: 700,
              }}
            >
              Analysis
            </span>
            <span
              style={{
                fontFamily: FONTS.mono,
                fontSize: 11,
                fontWeight: 600,
                color: t.enriched_audio ? LED_COLORS.green.on : LED_COLORS.orange.dim,
              }}
            >
              {t.enriched_audio ? "Complete" : "Pending"}
            </span>
          </div>

          {/* Cover art status */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "8px 0",
              borderBottom: `1px solid ${HARDWARE.border}`,
            }}
          >
            <span
              style={{
                fontFamily: FONTS.mono,
                fontSize: 10,
                color: HARDWARE.textDim,
                letterSpacing: 1,
                textTransform: "uppercase",
                fontWeight: 700,
              }}
            >
              Cover Art
            </span>
            <span
              style={{
                fontFamily: FONTS.mono,
                fontSize: 11,
                fontWeight: 600,
                color: t.cover_art_written ? LED_COLORS.green.on : LED_COLORS.orange.dim,
              }}
            >
              {t.cover_art_written ? "Embedded" : "Missing"}
            </span>
          </div>

          {/* Analyze button — shown when anything is missing */}
          {onAnalyze && (!t.enriched_audio || !t.cover_art_written) && (
            <div style={{ padding: "12px 0" }}>
              <button
                type="button"
                onClick={() => onAnalyze(t.id)}
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "8px 16px",
                  borderRadius: 4,
                  background: LED_COLORS.orange.on,
                  color: "#fff",
                  border: "none",
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                Analyze{!t.enriched_audio && !t.cover_art_written
                  ? ""
                  : !t.enriched_audio
                    ? " — BPM/Key"
                    : " — Cover Art"}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
