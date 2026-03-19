"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  fetchStats,
  exportCollection,
  type CatalogStats,
} from "@/lib/api";
import LCDDisplay from "@/components/ui/LCDDisplay";
import ActionButton from "@/components/ui/ActionButton";

// ─── Types ───────────────────────────────────────────────────────────────────

type ExportFormat = "rekordbox" | "traktor" | "csv";

const FORMATS: { id: ExportFormat; label: string; desc: string }[] = [
  { id: "rekordbox", label: "Rekordbox XML", desc: "Import via File \u2192 Import Collection from XML" },
  { id: "traktor", label: "Traktor NML", desc: "Place in Traktor\u2019s collection folder or import manually" },
  { id: "csv", label: "CSV", desc: "Spreadsheet-compatible export of track metadata" },
];

const GENRE_PILLS = ["All Tracks", "Techno", "House", "Trance", "Drum & Bass", "Disco", "Ambient"];

// ─── SVG Icons ───────────────────────────────────────────────────────────────

const FORMAT_ICONS: Record<string, React.ReactNode> = {
  rekordbox: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  ),
  traktor: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
      <line x1="12" y1="3" x2="12" y2="9" stroke="currentColor" strokeWidth="1.5" />
      <line x1="12" y1="15" x2="12" y2="21" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  csv: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="12" y2="17" />
    </svg>
  ),
  serato: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M4 12c0-4.4 3.6-8 8-8s8 3.6 8 8-3.6 8-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 12a4 4 0 108 0 4 4 0 00-8 0" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
};

// ─── Export Page ──────────────────────────────────────────────────────────────

export default function ExportPage() {
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [format, setFormat] = useState<ExportFormat>("rekordbox");
  const [genre, setGenre] = useState("All Tracks");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    fetchStats()
      .then(setStats)
      .catch((err) => toast.error(`Failed to load stats: ${err.message}`));
  }, []);

  const trackCount = stats?.total ?? 0;
  const genreParam = genre === "All Tracks" ? undefined : genre;

  async function handleExport() {
    setExporting(true);
    try {
      await exportCollection(format, genreParam);
      toast.success(`Exported ${trackCount} tracks as ${format.toUpperCase()}`);
    } catch (err: unknown) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto" style={{ padding: "clamp(24px, 4vw, 40px)" }}>
        {/* Page header */}
        <div style={{ maxWidth: 800, margin: "0 auto" }}>
          <h2
            className="font-sans font-black"
            style={{ fontSize: "clamp(24px, 3.5vw, 32px)", letterSpacing: -1, marginBottom: 8, lineHeight: 1.1 }}
          >
            Export your collection
          </h2>
          <p
            className="font-sans text-sm"
            style={{ color: "var(--hw-text-sec)", marginBottom: 32, lineHeight: 1.6, maxWidth: 500 }}
          >
            Download your library in a format compatible with your DJ software.
          </p>

          {/* LCD Stats Row */}
          <div className="grid grid-cols-3 gap-2.5 mb-8">
            <LCDDisplay value={stats?.total ?? "\u2014"} label="Total Tracks" />
            <LCDDisplay value={stats?.flags?.enriched_audio ?? "\u2014"} label="BPM / Key" />
            <LCDDisplay value={stats?.flags?.metadata_written ?? "\u2014"} label="Tagged" />
          </div>

          {/* Format Selection */}
          <div
            className="font-mono text-[10px] font-bold uppercase"
            style={{ letterSpacing: 2, color: "var(--hw-text-muted)", padding: "20px 0 8px" }}
          >
            Export Format
          </div>

          <div className="flex flex-col gap-3">
            {FORMATS.map((f) => {
              const sel = format === f.id;
              return (
                <div
                  key={f.id}
                  onClick={() => setFormat(f.id)}
                  className="flex items-center gap-4 cursor-pointer transition-all duration-200"
                  style={{
                    background: sel ? "var(--hw-card-hover)" : "var(--hw-card-bg)",
                    border: `1.5px solid ${sel ? "color-mix(in srgb, var(--led-blue) 35%, transparent)" : "var(--hw-card-border)"}`,
                    borderRadius: 8,
                    padding: "16px 20px",
                    boxShadow: sel
                      ? "0 0 20px color-mix(in srgb, var(--led-blue) 8%, transparent), 0 4px 12px rgba(0,0,0,0.1)"
                      : "none",
                  }}
                >
                  {/* Radio circle */}
                  <div
                    className="flex items-center justify-center flex-shrink-0 transition-colors"
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      border: `2px solid ${sel ? "var(--led-blue)" : "var(--hw-border-light)"}`,
                    }}
                  >
                    {sel && (
                      <div
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: "50%",
                          background: "var(--led-blue)",
                          boxShadow: "0 0 12px color-mix(in srgb, var(--led-blue) 33%, transparent)",
                        }}
                      />
                    )}
                  </div>

                  {/* Icon */}
                  <div style={{ color: sel ? "var(--led-blue)" : "var(--hw-text-dim)" }}>
                    {FORMAT_ICONS[f.id]}
                  </div>

                  {/* Label + description */}
                  <div className="flex-1 min-w-0">
                    <div className="font-sans text-sm font-semibold" style={{ color: "var(--hw-text)", lineHeight: 1.3 }}>
                      {f.label}
                    </div>
                    <div className="font-sans text-xs mt-0.5" style={{ color: "var(--hw-text-dim)" }}>
                      {f.desc}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Serato — disabled */}
            <div
              className="flex items-center gap-4 transition-all duration-200"
              style={{
                background: "var(--hw-card-bg)",
                border: "1.5px solid var(--hw-card-border)",
                borderRadius: 8,
                padding: "16px 20px",
                opacity: 0.4,
                cursor: "not-allowed",
              }}
            >
              {/* Radio circle (disabled) */}
              <div
                className="flex items-center justify-center flex-shrink-0"
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  border: "2px solid var(--hw-border-light)",
                }}
              />

              {/* Icon */}
              <div style={{ color: "var(--hw-text-muted)" }}>
                {FORMAT_ICONS.serato}
              </div>

              {/* Label + badge */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="font-sans text-sm font-semibold" style={{ color: "var(--hw-text)" }}>
                    Serato
                  </span>
                  <span
                    className="font-mono text-[10px] font-bold uppercase"
                    style={{
                      color: "var(--hw-text-muted)",
                      background: "var(--hw-raised)",
                      padding: "3px 8px",
                      borderRadius: 4,
                      letterSpacing: 1,
                    }}
                  >
                    Coming Soon
                  </span>
                </div>
                <div className="font-sans text-xs mt-0.5" style={{ color: "var(--hw-text-dim)" }}>
                  Serato DJ crate export
                </div>
              </div>
            </div>
          </div>

          {/* Genre Filter */}
          <div
            className="font-mono text-[10px] font-bold uppercase"
            style={{ letterSpacing: 2, color: "var(--hw-text-muted)", padding: "28px 0 8px" }}
          >
            Filter by Genre
          </div>

          <div className="flex flex-wrap gap-2">
            {GENRE_PILLS.map((g) => {
              const active = genre === g;
              return (
                <button
                  key={g}
                  onClick={() => setGenre(g)}
                  className="font-mono text-xs font-semibold cursor-pointer transition-all duration-200"
                  style={{
                    padding: "8px 16px",
                    borderRadius: 6,
                    border: `1.5px solid ${active ? "color-mix(in srgb, var(--led-blue) 35%, transparent)" : "var(--hw-card-border)"}`,
                    background: active
                      ? "color-mix(in srgb, var(--led-blue) 12%, transparent)"
                      : "var(--hw-card-bg)",
                    color: active ? "var(--led-blue)" : "var(--hw-text-dim)",
                    letterSpacing: 0.5,
                  }}
                >
                  {g}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Sticky footer */}
      <div
        className="flex items-center justify-between flex-shrink-0"
        style={{
          borderTop: "1px solid var(--hw-border-light)",
          background: "color-mix(in srgb, var(--hw-surface) 94%, transparent)",
          backdropFilter: "blur(8px)",
          padding: "14px clamp(16px, 3vw, 32px)",
        }}
      >
        <span className="font-sans text-sm" style={{ color: "var(--hw-text-dim)" }}>
          {trackCount} tracks &rarr; {format.toUpperCase()}
          {genre !== "All Tracks" && ` \u00b7 ${genre}`}
        </span>
        <ActionButton
          disabled={exporting || trackCount === 0}
          onClick={handleExport}
        >
          {exporting ? "Exporting\u2026" : `Export ${trackCount} tracks`}
        </ActionButton>
      </div>
    </div>
  );
}
