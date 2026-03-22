"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Filter } from "lucide-react";
import {
  fetchTracks,
  fetchStats,
  type Track,
  type CatalogStats,
} from "@/lib/api";

import TrackCard from "@/components/ui/TrackCard";
import TrackListRow from "@/components/ui/TrackListRow";
import TrackCompactRow from "@/components/ui/TrackCompactRow";
import MiniSearch from "@/components/ui/MiniSearch";
import FilterPopover, { type Filters } from "@/components/ui/FilterPopover";
import DetailPanel from "@/components/ui/DetailPanel";
import ViewToggle from "@/components/ui/ViewToggle";
import CrateItem from "@/components/ui/CrateItem";
import LCDDisplay from "@/components/ui/LCDDisplay";

type ViewMode = "grid" | "list" | "compact";

const PITCH_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

/** Resolve musical key: prefer key_normalized, fall back to Spotify key+mode integers. */
function resolveKey(t: Track): string | undefined {
  if (t.key_normalized) return t.key_normalized;
  if (t.key != null) {
    const pitch = PITCH_NAMES[t.key];
    if (!pitch) return undefined;
    const scale = t.mode === 1 ? "major" : "minor";
    return `${pitch} ${scale}`;
  }
  return undefined;
}

/** Map API Track to the shape the sub-components expect. */
function toComponentTrack(t: Track) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    bpm: t.tempo ? Math.round(t.tempo) : undefined,
    key: resolveKey(t),
    genre: t.genres?.split(",")[0]?.trim() || undefined,
    energy: t.energy,
    status: t.acquisition_status,
    artwork_url: t.artwork_url,
    local_path: t.local_path,
    created_at: t.created_at,
    preview_url: t.preview_url,
  };
}

export default function CatalogPage() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(true);
  // New design state
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [activeCrate, setActiveCrate] = useState("All Tracks");
  const [filters, setFilters] = useState<Filters>({
    genres: [],
    statuses: [],
    artists: [],
    keys: [],
    bpmMin: 70,
    bpmMax: 180,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tracksData, statsData] = await Promise.all([
        fetchTracks({
          page,
          per_page: perPage,
          status: statusFilter || "available",
          search: search || undefined,
          sort_by: sortBy,
          sort_dir: sortDir,
        }),
        fetchStats(),
      ]);
      setTracks(tracksData.tracks);
      setTotal(tracksData.total);
      setStats(statsData);
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Failed to load catalog",
      );
    } finally {
      setLoading(false);
    }
  }, [page, perPage, statusFilter, search, sortBy, sortDir]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.ceil(total / perPage);

  // Derive crate data from loaded tracks
  const { crateCounts, allGenres, allArtists, allKeys, allStatuses } =
    useMemo(() => {
      const genreSet = new Set<string>();
      const artistSet = new Set<string>();
      const keySet = new Set<string>();
      const statusSet = new Set<string>();
      const genreCounts: Record<string, number> = {};

      tracks.forEach((t) => {
        if (t.genres) {
          t.genres.split(",").forEach((g) => {
            const trimmed = g.trim();
            if (trimmed) {
              genreSet.add(trimmed);
              genreCounts[trimmed] = (genreCounts[trimmed] || 0) + 1;
            }
          });
        }
        if (t.artist) artistSet.add(t.artist);
        const mk = resolveKey(t);
        if (mk) keySet.add(mk);
        if (t.acquisition_status) statusSet.add(t.acquisition_status);
      });

      const crates: Record<string, number> = { "All Tracks": tracks.length };
      Object.entries(genreCounts)
        .sort(([, a], [, b]) => b - a)
        .forEach(([genre, count]) => {
          crates[genre] = count;
        });

      return {
        crateCounts: crates,
        allGenres: [...genreSet].sort(),
        allArtists: [...artistSet].sort(),
        allKeys: [...keySet].sort(),
        allStatuses: [...statusSet],
      };
    }, [tracks]);

  // Client-side filtering (genres, artists, keys, bpm from the filter popover)
  const filteredTracks = useMemo(() => {
    return tracks.filter((t) => {
      // Crate filter (genre-based)
      if (activeCrate !== "All Tracks") {
        const trackGenres =
          t.genres?.split(",").map((g) => g.trim()) ?? [];
        if (!trackGenres.includes(activeCrate)) return false;
      }
      // Genre filter
      if (filters.genres.length > 0) {
        const trackGenres =
          t.genres?.split(",").map((g) => g.trim()) ?? [];
        if (!filters.genres.some((g) => trackGenres.includes(g)))
          return false;
      }
      // Status filter
      if (
        filters.statuses.length > 0 &&
        !filters.statuses.includes(t.acquisition_status)
      )
        return false;
      // Artist filter
      if (filters.artists.length > 0 && !filters.artists.includes(t.artist))
        return false;
      // Key filter
      if (filters.keys.length > 0) {
        const mk = resolveKey(t);
        if (!mk || !filters.keys.includes(mk)) return false;
      }
      // BPM range filter
      if (t.tempo) {
        const bpm = Math.round(t.tempo);
        if (bpm < filters.bpmMin || bpm > filters.bpmMax) return false;
      }
      return true;
    });
  }, [tracks, activeCrate, filters]);

  const activeFilterCount =
    filters.genres.length +
    filters.statuses.length +
    filters.artists.length +
    filters.keys.length +
    (filters.bpmMin > 70 || filters.bpmMax < 180 ? 1 : 0);

  const clearFilters = () =>
    setFilters({
      genres: [],
      statuses: [],
      artists: [],
      keys: [],
      bpmMin: 70,
      bpmMax: 180,
    });

  return (
    <div className="flex h-full" style={{ minHeight: "calc(100vh - 64px)" }}>
      {/* ── Crate Sidebar ── */}
      <div
        className="hidden md:flex flex-col shrink-0"
        style={{
          width: 200,
          borderRight: "1px solid var(--hw-border-light)",
          background: "var(--hw-surface)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 14px 12px",
            borderBottom: "1px solid var(--hw-border)",
          }}
        >
          <span
            className="font-mono uppercase"
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--hw-text-dim)",
              letterSpacing: 1.5,
            }}
          >
            CRATES
          </span>
        </div>

        {/* Crate list */}
        <div className="flex-1 overflow-auto" style={{ padding: "6px 6px" }}>
          {Object.entries(crateCounts).map(([name, count]) => (
            <CrateItem
              key={name}
              name={name}
              count={count}
              active={activeCrate === name}
              onClick={() => setActiveCrate(name)}
            />
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 14px",
            borderTop: "1px solid var(--hw-border)",
          }}
        >
          <span
            className="font-mono"
            style={{
              fontSize: 10,
              color: "var(--hw-text-muted)",
              letterSpacing: 0.5,
            }}
          >
            {total} total tracks
          </span>
        </div>
      </div>

      {/* ── Main Content Area ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* ── Sticky Filter Bar ── */}
        <div
          className="shrink-0"
          style={{
            padding: "12px clamp(16px, 2vw, 24px)",
            borderBottom: "1px solid var(--hw-border-light)",
            background: "color-mix(in srgb, var(--hw-body) 94%, transparent)",
            backdropFilter: "blur(8px)",
          }}
        >
          <div className="flex items-center gap-3">
            <h1
              className="font-sans"
              style={{ fontSize: 22, fontWeight: 900, letterSpacing: -0.8 }}
            >
              Catalog
            </h1>
            <span
              className="font-mono"
              style={{ fontSize: 11, color: "var(--hw-text-dim)" }}
            >
              {filteredTracks.length} tracks
            </span>
            <div className="flex-1" />

            {/* Import button */}
            <a
              href="/import"
              className="font-mono text-xs font-bold tracking-wide"
              style={{
                padding: "6px 14px",
                borderRadius: 5,
                background: "var(--led-blue)",
                color: "#fff",
                border: "none",
                cursor: "pointer",
                textDecoration: "none",
              }}
            >
              Import a Playlist
            </a>

            {/* Search */}
            <div style={{ width: "clamp(160px, 22vw, 260px)" }}>
              <MiniSearch
                value={search}
                onChange={(v) => {
                  setSearch(v);
                  setPage(1);
                }}
                placeholder="Search..."
              />
            </div>

            {/* Filter button */}
            <FilterButton
              activeCount={activeFilterCount}
              open={showFilters}
              onClick={() => setShowFilters(!showFilters)}
            />

            {/* View toggle */}
            <ViewToggle mode={viewMode} onChange={setViewMode} />
          </div>

          {/* Active filter tags */}
          {activeFilterCount > 0 && (
            <div
              className="flex items-center gap-1.5 flex-wrap"
              style={{ marginTop: 10 }}
            >
              {filters.genres.map((g) => (
                <ActiveTag
                  key={`g-${g}`}
                  label={`Genre: ${g}`}
                  onRemove={() =>
                    setFilters((f) => ({
                      ...f,
                      genres: f.genres.filter((x) => x !== g),
                    }))
                  }
                />
              ))}
              {filters.artists.map((a) => (
                <ActiveTag
                  key={`a-${a}`}
                  label={`Artist: ${a}`}
                  onRemove={() =>
                    setFilters((f) => ({
                      ...f,
                      artists: f.artists.filter((x) => x !== a),
                    }))
                  }
                />
              ))}
              {filters.keys.map((k) => (
                <ActiveTag
                  key={`k-${k}`}
                  label={`Key: ${k}`}
                  onRemove={() =>
                    setFilters((f) => ({
                      ...f,
                      keys: f.keys.filter((x) => x !== k),
                    }))
                  }
                />
              ))}
              {filters.statuses.map((s) => (
                <ActiveTag
                  key={`s-${s}`}
                  label={`Status: ${s}`}
                  onRemove={() =>
                    setFilters((f) => ({
                      ...f,
                      statuses: f.statuses.filter((x) => x !== s),
                    }))
                  }
                />
              ))}
              {(filters.bpmMin > 70 || filters.bpmMax < 180) && (
                <ActiveTag
                  label={`BPM: ${filters.bpmMin}\u2013${filters.bpmMax}`}
                  onRemove={() =>
                    setFilters((f) => ({ ...f, bpmMin: 70, bpmMax: 180 }))
                  }
                />
              )}
              <button
                type="button"
                onClick={clearFilters}
                className="font-mono"
                style={{
                  fontSize: 10,
                  color: "var(--led-blue)",
                  cursor: "pointer",
                  marginLeft: 4,
                  background: "none",
                  border: "none",
                }}
              >
                Clear all
              </button>
            </div>
          )}
        </div>

        {/* ── Stats row (LCD Displays) ── */}
        {stats && (
          <div
            className="grid grid-cols-2 sm:grid-cols-4 gap-3 shrink-0"
            style={{ padding: "12px clamp(16px, 2vw, 24px)" }}
          >
            <LCDDisplay value={stats.total} label="Total" />
            <LCDDisplay
              value={stats.by_status?.available ?? 0}
              label="Available"
            />
            <LCDDisplay
              value={stats.by_status?.downloading ?? 0}
              label="Downloading"
            />
            <LCDDisplay
              value={stats.by_status?.failed ?? 0}
              label="Failed"
            />
          </div>
        )}

        {/* ── Content area (multi-view) ── */}
        <div
          className="flex-1 overflow-auto"
          style={{
            padding:
              viewMode === "grid" ? "clamp(12px, 2vw, 20px)" : 0,
          }}
        >
          {loading ? (
            <div className="text-center" style={{ padding: "60px 20px" }}>
              <span
                className="font-sans"
                style={{ fontSize: 16, color: "var(--hw-text-dim)" }}
              >
                Loading...
              </span>
            </div>
          ) : filteredTracks.length === 0 ? (
            <div className="text-center" style={{ padding: "60px 20px" }}>
              <span
                className="font-sans"
                style={{ fontSize: 16, color: "var(--hw-text-dim)" }}
              >
                No tracks match your filters
              </span>
            </div>
          ) : viewMode === "grid" ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(220px, 1fr))",
                gap: "clamp(10px, 1.5vw, 16px)",
              }}
            >
              {filteredTracks.map((t) => (
                <TrackCard
                  key={t.id}
                  track={toComponentTrack(t)}
                  onClick={() => setSelectedTrack(t)}
                />
              ))}
            </div>
          ) : viewMode === "list" ? (
            <div
              style={{
                margin: "clamp(12px, 2vw, 20px)",
                background: "var(--hw-list-bg)",
                border: "1.5px solid var(--hw-list-border)",
                borderRadius: 6,
                overflow: "hidden",
                boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
              }}
            >
              {/* List header */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "44px 2fr 1.5fr 50px 60px 0.5fr 0.8fr 0.6fr 48px",
                  padding: "10px 14px",
                  gap: 10,
                  background: "var(--hw-list-header)",
                  borderBottom: "1.5px solid var(--hw-list-border)",
                  position: "sticky",
                  top: 0,
                  zIndex: 2,
                }}
              >
                {([
                  { label: "", key: "" },
                  { label: "Track", key: "title" },
                  { label: "Artist", key: "artist" },
                  { label: "BPM", key: "tempo" },
                  { label: "Key", key: "key_normalized" },
                  { label: "Energy", key: "energy" },
                  { label: "Tags", key: "genres" },
                  { label: "Added", key: "created_at" },
                  { label: "", key: "" },
                ] as const).map((col, i) =>
                  col.key ? (
                    <button
                      key={col.key}
                      onClick={() => {
                        if (sortBy === col.key) {
                          setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                        } else {
                          setSortBy(col.key);
                          setSortDir("desc");
                        }
                        setPage(1);
                      }}
                      className="font-mono uppercase text-left"
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        color: "var(--hw-text-dim)",
                        letterSpacing: 1.5,
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      {col.label}
                      {sortBy === col.key && (
                        <span style={{ marginLeft: 4, fontSize: 10 }}>
                          {sortDir === "asc" ? "\u25B2" : "\u25BC"}
                        </span>
                      )}
                    </button>
                  ) : (
                    <span
                      key={col.label || `col-${i}`}
                      className="font-mono uppercase"
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        color: "var(--hw-text-dim)",
                        letterSpacing: 1.5,
                      }}
                    >
                      {col.label}
                    </span>
                  )
                )}
              </div>
              {filteredTracks.map((t, i) => (
                <TrackListRow
                  key={t.id}
                  track={toComponentTrack(t)}
                  isLast={i === filteredTracks.length - 1}
                  onClick={() => setSelectedTrack(t)}
                />
              ))}
            </div>
          ) : (
            <div
              style={{
                margin: "clamp(12px, 2vw, 20px)",
                background: "var(--hw-list-bg)",
                border: "1.5px solid var(--hw-list-border)",
                borderRadius: 6,
                overflow: "hidden",
                boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
              }}
            >
              {/* Compact header */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "6px 2fr 1.5fr 0.6fr 0.5fr 0.6fr 0.5fr 0.6fr",
                  padding: "8px 14px",
                  gap: 10,
                  background: "var(--hw-list-header)",
                  borderBottom: "1.5px solid var(--hw-list-border)",
                  position: "sticky",
                  top: 0,
                  zIndex: 2,
                }}
              >
                {([
                  { label: "", key: "" },
                  { label: "Track", key: "title" },
                  { label: "Artist", key: "artist" },
                  { label: "BPM", key: "tempo" },
                  { label: "Key", key: "key_normalized" },
                  { label: "Genre", key: "genres" },
                  { label: "Energy", key: "energy" },
                  { label: "Added", key: "created_at" },
                ] as const).map((col, i) =>
                  col.key ? (
                    <button
                      key={col.key}
                      onClick={() => {
                        if (sortBy === col.key) {
                          setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                        } else {
                          setSortBy(col.key);
                          setSortDir("desc");
                        }
                        setPage(1);
                      }}
                      className="font-mono uppercase text-left"
                      style={{
                        fontSize: 8,
                        fontWeight: 700,
                        color: "var(--hw-text-dim)",
                        letterSpacing: 1.5,
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      {col.label}
                      {sortBy === col.key && (
                        <span style={{ marginLeft: 4, fontSize: 9 }}>
                          {sortDir === "asc" ? "\u25B2" : "\u25BC"}
                        </span>
                      )}
                    </button>
                  ) : (
                    <span
                      key={col.label || `col-${i}`}
                      className="font-mono uppercase"
                      style={{
                        fontSize: 8,
                        fontWeight: 700,
                        color: "var(--hw-text-dim)",
                        letterSpacing: 1.5,
                      }}
                    >
                      {col.label}
                    </span>
                  )
                )}
              </div>
              {filteredTracks.map((t, i) => (
                <TrackCompactRow
                  key={t.id}
                  track={toComponentTrack(t)}
                  isLast={i === filteredTracks.length - 1}
                  onClick={() => setSelectedTrack(t)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Pagination ── */}
        <div
          className="flex items-center justify-between shrink-0"
          style={{
            padding: "10px clamp(16px, 2vw, 24px)",
            borderTop: "1px solid var(--hw-border)",
          }}
        >
          <div className="flex items-center gap-3">
            <p
              className="font-mono"
              style={{ fontSize: 11, color: "var(--hw-text-dim)" }}
            >
              {total} tracks
            </p>
            <div className="flex items-center gap-1.5">
              <span
                className="font-mono"
                style={{ fontSize: 10, color: "var(--hw-text-muted)" }}
              >
                Show
              </span>
              <select
                value={perPage}
                onChange={(e) => {
                  setPerPage(Number(e.target.value));
                  setPage(1);
                }}
                className="font-mono"
                style={{
                  fontSize: 10,
                  padding: "4px 8px",
                  borderRadius: 4,
                  border: "1px solid var(--hw-border)",
                  background: "var(--hw-raised)",
                  color: "var(--hw-text)",
                  outline: "none",
                }}
              >
                {[15, 30, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="font-mono disabled:opacity-30"
                style={{
                  fontSize: 11,
                  padding: "4px 12px",
                  borderRadius: 4,
                  color: "var(--hw-text-dim)",
                  background: "none",
                  border: "1px solid var(--hw-border)",
                  cursor: "pointer",
                }}
              >
                Prev
              </button>
              <span
                className="font-mono"
                style={{ fontSize: 11, color: "var(--hw-text-dim)" }}
              >
                {page} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="font-mono disabled:opacity-30"
                style={{
                  fontSize: 11,
                  padding: "4px 12px",
                  borderRadius: 4,
                  color: "var(--hw-text-dim)",
                  background: "none",
                  border: "1px solid var(--hw-border)",
                  cursor: "pointer",
                }}
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Detail Panel ── */}
      {selectedTrack && (
        <DetailPanel
          track={toComponentTrack(selectedTrack)}
          onClose={() => setSelectedTrack(null)}
        />
      )}

      {/* ── Filter Popover ── */}
      {showFilters && (
        <FilterPopover
          filters={filters}
          setFilters={setFilters}
          allGenres={allGenres}
          allStatuses={allStatuses}
          allArtists={allArtists}
          allKeys={allKeys}
          onClose={() => setShowFilters(false)}
        />
      )}

    </div>
  );
}

/* ── Filter Button ── */
function FilterButton({
  activeCount,
  open,
  onClick,
}: {
  activeCount: number;
  open: boolean;
  onClick: () => void;
}) {
  const lit = open || activeCount > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 font-mono transition-all duration-150"
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1,
        padding: "6px 14px",
        borderRadius: 5,
        cursor: "pointer",
        border: `1px solid ${lit ? "color-mix(in srgb, var(--led-blue) 27%, transparent)" : "var(--hw-border-light)"}`,
        background: lit
          ? "color-mix(in srgb, var(--led-blue) 5%, transparent)"
          : "transparent",
        color: lit ? "var(--led-blue)" : "var(--hw-text-dim)",
      }}
    >
      <Filter size={14} />
      Filters
      {activeCount > 0 && (
        <span
          className="font-mono"
          style={{
            fontSize: 9,
            fontWeight: 700,
            color: "#fff",
            background: "var(--led-blue)",
            width: 18,
            height: 18,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {activeCount}
        </span>
      )}
    </button>
  );
}

/* ── Active Filter Tag (removable pill) ── */
function ActiveTag({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono"
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: "var(--led-blue)",
        background:
          "color-mix(in srgb, var(--led-blue) 6%, transparent)",
        border:
          "1px solid color-mix(in srgb, var(--led-blue) 20%, transparent)",
        padding: "3px 10px",
        borderRadius: 4,
      }}
    >
      {label}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        style={{
          cursor: "pointer",
          fontSize: 13,
          lineHeight: 1,
          opacity: 0.7,
          background: "none",
          border: "none",
          color: "inherit",
          padding: 0,
        }}
      >
        x
      </button>
    </span>
  );
}

