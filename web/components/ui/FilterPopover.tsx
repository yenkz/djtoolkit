"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { LED_COLORS, HARDWARE, FONTS } from "@/lib/design-system/tokens";

/* ── Types ── */
export interface Filters {
  genres: string[];
  statuses: string[];
  artists: string[];
  keys: string[];
  bpmMin: number;
  bpmMax: number;
}

interface FilterPopoverProps {
  filters: Filters;
  setFilters: (f: Filters | ((prev: Filters) => Filters)) => void;
  allGenres: string[];
  allStatuses: string[];
  allArtists: string[];
  allKeys: string[];
  onClose: () => void;
}

/* ── Sub-components ── */

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  const [h, setH] = useState(false);
  const c = LED_COLORS.blue;

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        fontFamily: FONTS.mono,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1,
        padding: "6px 14px",
        borderRadius: 4,
        cursor: "pointer",
        whiteSpace: "nowrap",
        background: active ? `${c.on}15` : h ? "#8A9AAA0c" : "transparent",
        color: active ? c.on : h ? "#A0B8CC" : "#8A9AAA",
        border: `1px solid ${active ? c.on + "44" : h ? HARDWARE.borderLight : "transparent"}`,
        transition: "all 0.15s",
      }}
    >
      {label}
    </button>
  );
}

function MiniSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div style={{ position: "relative" }}>
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke={HARDWARE.textMuted}
        strokeWidth="2"
        strokeLinecap="round"
        style={{
          position: "absolute",
          left: 9,
          top: "50%",
          transform: "translateY(-50%)",
        }}
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          fontFamily: FONTS.sans,
          fontSize: 12,
          color: HARDWARE.text,
          background: HARDWARE.surface,
          border: `1px solid ${HARDWARE.borderLight}`,
          borderRadius: 4,
          padding: "6px 10px 6px 28px",
          outline: "none",
        }}
      />
    </div>
  );
}

function FilterSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span
        style={{
          fontFamily: FONTS.mono,
          fontSize: 9,
          fontWeight: 700,
          color: HARDWARE.textDim,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          display: "block",
          marginBottom: 8,
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

/* ── Main component ── */

export default function FilterPopover({
  filters,
  setFilters,
  allGenres,
  allStatuses,
  allArtists,
  allKeys,
  onClose,
}: FilterPopoverProps) {
  const [genreSearch, setGenreSearch] = useState("");
  const [artistSearch, setArtistSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const c = LED_COLORS.blue;
  const panelBg = HARDWARE.raised;
  const headerBg = "#2A282A";

  const toggle = useCallback(
    (key: keyof Pick<Filters, "genres" | "statuses" | "artists" | "keys">, val: string) => {
      setFilters((f) => {
        const arr = f[key];
        return {
          ...f,
          [key]: arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val],
        };
      });
    },
    [setFilters]
  );

  const resetAll = useCallback(() => {
    setFilters({
      genres: [],
      statuses: [],
      artists: [],
      keys: [],
      bpmMin: 70,
      bpmMax: 180,
    });
  }, [setFilters]);

  /* Focus trap + Escape */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && ref.current) {
        const focusable = ref.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* Auto-focus panel on mount */
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("input, button");
    first?.focus();
  }, []);

  const filteredGenres = allGenres.filter(
    (g) => !genreSearch || g.toLowerCase().includes(genreSearch.toLowerCase())
  );
  const filteredArtists = allArtists.filter(
    (a) => !artistSearch || a.toLowerCase().includes(artistSearch.toLowerCase())
  );

  const statusColors: Record<string, string> = {
    ready: "#44DD44",
    available: "#44DD44",
    downloading: c.on,
    error: LED_COLORS.red.on,
    failed: LED_COLORS.red.on,
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.6)",
          zIndex: 10000,
        }}
      />

      {/* Modal */}
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Filter tracks"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "clamp(360px, 45vw, 460px)",
          maxHeight: "80vh",
          border: `1.5px solid ${HARDWARE.borderLight}`,
          borderRadius: 10,
          boxShadow:
            "0 16px 64px rgba(0,0,0,0.5), 0 4px 20px rgba(0,0,0,0.3)",
          zIndex: 10001,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          isolation: "isolate",
        }}
      >
        {/* Solid opaque background layer */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: panelBg,
            borderRadius: 10,
            zIndex: -1,
          }}
        />

        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px 20px",
            borderBottom: `1px solid ${HARDWARE.border}`,
            background: headerBg,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily: FONTS.sans,
              fontSize: 16,
              fontWeight: 800,
              color: HARDWARE.text,
            }}
          >
            Filters
          </span>
          <button
            onClick={onClose}
            aria-label="Close filters"
            style={{
              fontFamily: FONTS.sans,
              fontSize: 18,
              color: HARDWARE.textDim,
              cursor: "pointer",
              width: 28,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              background: `${HARDWARE.text}08`,
              border: "none",
            }}
          >
            &#10005;
          </button>
        </div>

        {/* Scrollable body */}
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: "16px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 20,
            background: panelBg,
          }}
        >
          {/* Genre */}
          <FilterSection label="Genre">
            <MiniSearch
              value={genreSearch}
              onChange={setGenreSearch}
              placeholder="Search genres..."
            />
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                marginTop: 8,
              }}
            >
              {filteredGenres.map((g) => (
                <FilterPill
                  key={g}
                  label={g}
                  active={filters.genres.includes(g)}
                  onClick={() => toggle("genres", g)}
                />
              ))}
              {filteredGenres.length === 0 && (
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 12,
                    color: HARDWARE.textMuted,
                  }}
                >
                  No matches
                </span>
              )}
            </div>
          </FilterSection>

          {/* Artist */}
          <FilterSection label="Artist">
            <MiniSearch
              value={artistSearch}
              onChange={setArtistSearch}
              placeholder="Search artists..."
            />
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                marginTop: 8,
              }}
            >
              {filteredArtists.map((a) => (
                <FilterPill
                  key={a}
                  label={a}
                  active={filters.artists.includes(a)}
                  onClick={() => toggle("artists", a)}
                />
              ))}
              {filteredArtists.length === 0 && (
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 12,
                    color: HARDWARE.textMuted,
                  }}
                >
                  No matches
                </span>
              )}
            </div>
          </FilterSection>

          {/* Key */}
          <FilterSection label="Key">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {allKeys.map((k) => (
                <FilterPill
                  key={k}
                  label={k}
                  active={filters.keys.includes(k)}
                  onClick={() => toggle("keys", k)}
                />
              ))}
            </div>
          </FilterSection>

          {/* Status */}
          <FilterSection label="Status">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {allStatuses.map((s) => {
                const dotColor = statusColors[s] || "#8A9AAA";
                return (
                  <FilterPill
                    key={s}
                    label={
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                        }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: dotColor,
                            display: "inline-block",
                          }}
                        />
                        {s}
                      </span>
                    }
                    active={filters.statuses.includes(s)}
                    onClick={() => toggle("statuses", s)}
                  />
                );
              })}
            </div>
          </FilterSection>

          {/* BPM Range */}
          <FilterSection
            label={`BPM Range: ${filters.bpmMin} \u2013 ${filters.bpmMax}`}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "4px 0",
              }}
            >
              <span
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 11,
                  color: HARDWARE.textDim,
                  minWidth: 28,
                }}
              >
                {filters.bpmMin}
              </span>
              <input
                type="range"
                min={70}
                max={180}
                value={filters.bpmMin}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    bpmMin: Math.min(Number(e.target.value), f.bpmMax - 5),
                  }))
                }
                style={{ flex: 1, accentColor: c.on }}
              />
              <input
                type="range"
                min={70}
                max={180}
                value={filters.bpmMax}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    bpmMax: Math.max(Number(e.target.value), f.bpmMin + 5),
                  }))
                }
                style={{ flex: 1, accentColor: c.on }}
              />
              <span
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 11,
                  color: HARDWARE.textDim,
                  minWidth: 28,
                  textAlign: "right",
                }}
              >
                {filters.bpmMax}
              </span>
            </div>
          </FilterSection>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "14px 20px",
            borderTop: `1px solid ${HARDWARE.border}`,
            background: headerBg,
            flexShrink: 0,
          }}
        >
          <button
            onClick={resetAll}
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
            Reset all
          </button>
          <button
            onClick={onClose}
            style={{
              fontFamily: FONTS.mono,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1.5,
              padding: "9px 24px",
              borderRadius: 5,
              background: c.on,
              color: "#fff",
              border: "none",
              cursor: "pointer",
              boxShadow: "0 2px 8px rgba(68,136,255,0.3)",
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </>
  );
}
