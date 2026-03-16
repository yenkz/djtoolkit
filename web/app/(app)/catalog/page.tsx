"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  fetchTracks,
  fetchStats,
  importCsv,
  fetchSpotifyPlaylists,
  importSpotifyPlaylist,
  type Track,
  type CatalogStats,
} from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  available: "bg-led-green/20 text-led-green",
  candidate: "bg-led-orange/20 text-led-orange",
  downloading: "bg-led-blue/20 text-led-blue",
  failed: "bg-led-red/20 text-led-red",
  duplicate: "bg-hw-raised text-hw-text-dim",
};

const API_URL = "/api";

export default function CatalogPage() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [showSpotifyModal, setShowSpotifyModal] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tracksData, statsData] = await Promise.all([
        fetchTracks({ page, per_page: perPage, status: statusFilter || undefined, search: search || undefined }),
        fetchStats(),
      ]);
      setTracks(tracksData.tracks);
      setTotal(tracksData.total);
      setStats(statsData);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to load catalog");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, statusFilter, search]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / perPage);

  function copyPath(trackId: number, path: string) {
    navigator.clipboard.writeText(path);
    setCopiedId(trackId);
    setTimeout(() => setCopiedId(null), 1500);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-hw-text">Catalog</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCsvModal(true)}
            className="rounded-lg bg-led-blue px-3 py-1.5 text-sm font-medium text-hw-text hover:bg-led-blue/80"
          >
            Import CSV
          </button>
          <button
            onClick={async () => {
              const supabase = createClient();
              const { data: { session } } = await supabase.auth.getSession();
              const token = session?.access_token ?? "";
              window.location.href = `${API_URL}/auth/spotify/connect?token=${encodeURIComponent(token)}&return_to=/catalog`;
            }}
            className="rounded-lg border border-led-green px-3 py-1.5 text-sm font-medium text-led-green hover:bg-led-green/10"
          >
            Connect Spotify
          </button>
          <button
            onClick={() => setShowSpotifyModal(true)}
            className="rounded-lg border border-hw-border px-3 py-1.5 text-sm font-medium text-hw-text hover:bg-hw-raised"
          >
            Import Playlist
          </button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Total", value: stats.total },
            { label: "Available", value: stats.by_status?.available ?? 0 },
            { label: "Downloading", value: stats.by_status?.downloading ?? 0 },
            { label: "Failed", value: stats.by_status?.failed ?? 0 },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-lg border border-hw-border bg-hw-surface p-3">
              <p className="text-2xl font-bold text-hw-text">{value}</p>
              <p className="text-xs text-hw-text-dim">{label}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-3">
        <input
          type="text"
          placeholder="Search title or artist..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="flex-1 rounded-lg border border-hw-border bg-hw-raised px-3 py-2 text-sm text-hw-text placeholder-hw-text-dim focus:border-led-blue focus:outline-none"
        />
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-hw-border bg-hw-raised px-3 py-2 text-sm text-hw-text focus:border-led-blue focus:outline-none"
        >
          <option value="">All statuses</option>
          {["candidate", "downloading", "available", "failed", "duplicate"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div className="rounded-xl border border-hw-border bg-hw-surface overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hw-border text-left text-xs text-hw-text-dim">
              <th className="w-10 px-2 py-3"></th>
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3">Artist</th>
              <th className="px-4 py-3">Album</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-3 py-3">BPM</th>
              <th className="px-3 py-3">Style</th>
              <th className="px-4 py-3">Flags</th>
              <th className="px-3 py-3">Path</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-hw-text-dim">Loading...</td></tr>
            ) : tracks.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-hw-text-dim">No tracks found</td></tr>
            ) : tracks.map((t) => (
              <tr key={t.id} className="border-b border-hw-border/50 hover:bg-hw-raised/30">
                <td className="px-2 py-2.5 text-center">
                  {t.artwork_url ? (
                    <img
                      src={t.artwork_url}
                      alt=""
                      className="h-8 w-8 rounded object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className={`inline-flex h-8 w-8 items-center justify-center rounded ${t.cover_art_written ? "bg-led-blue/20" : "bg-hw-raised"}`}>
                      <svg className={`h-4 w-4 ${t.cover_art_written ? "text-led-blue" : "text-hw-text-dim"}`} fill="currentColor" viewBox="0 0 20 20">
                        <path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z" />
                      </svg>
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-hw-text">{t.title}</td>
                <td className="px-4 py-2.5 text-hw-text">{t.artist}</td>
                <td className="px-4 py-2.5 text-hw-text-dim">{t.album}</td>
                <td className="px-4 py-2.5">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[t.acquisition_status] ?? "bg-hw-raised text-hw-text"}`}>
                    {t.acquisition_status}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-hw-text tabular-nums">
                  {t.tempo ? Math.round(t.tempo) : <span className="text-hw-text-dim">—</span>}
                </td>
                <td className="px-3 py-2.5 text-hw-text-dim max-w-[140px] truncate" title={t.genres ?? ""}>
                  {t.genres || <span className="text-hw-text-dim">—</span>}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex gap-1">
                    {[
                      { label: "FP", val: t.fingerprinted },
                      { label: "SP", val: t.enriched_spotify },
                      { label: "MT", val: t.metadata_written },
                      { label: "LIB", val: t.in_library },
                    ].map(({ label, val }) => (
                      <span
                        key={label}
                        className={`rounded px-1 py-0.5 text-xs ${val ? "bg-led-green/20 text-led-green" : "bg-hw-raised text-hw-text-dim"}`}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  {t.local_path && t.acquisition_status === "available" ? (
                    <button
                      onClick={() => copyPath(t.id, t.local_path!)}
                      title={t.local_path}
                      className="rounded px-2 py-0.5 text-xs text-hw-text-dim hover:text-hw-text hover:bg-hw-raised transition-colors"
                    >
                      {copiedId === t.id ? "Copied!" : "Copy path"}
                    </button>
                  ) : (
                    <span className="text-hw-text-dim text-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-hw-text-dim">{total} tracks</p>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-hw-text-dim">Show</span>
            <select
              value={perPage}
              onChange={(e) => { setPerPage(Number(e.target.value)); setPage(1); }}
              className="rounded border border-hw-border bg-hw-raised px-2 py-1 text-xs text-hw-text focus:border-led-blue focus:outline-none"
            >
              {[15, 30, 50, 100].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded px-3 py-1 text-sm text-hw-text-dim hover:text-hw-text disabled:opacity-30"
            >
              Previous
            </button>
            <span className="text-sm text-hw-text-dim">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="rounded px-3 py-1 text-sm text-hw-text-dim hover:text-hw-text disabled:opacity-30"
            >
              Next
            </button>
          </div>
        )}
      </div>

      {showCsvModal && (
        <CsvImportModal onClose={() => { setShowCsvModal(false); load(); }} />
      )}
      {showSpotifyModal && (
        <SpotifyImportModal onClose={() => { setShowSpotifyModal(false); load(); }} />
      )}
    </div>
  );
}

function CsvImportModal({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleImport() {
    if (!file) return;
    setLoading(true);
    try {
      const result = await importCsv(file);
      toast.success(`Imported ${result.imported} tracks, ${result.jobs_created} jobs created`);
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-xl border border-hw-border bg-hw-surface p-6 shadow-2xl">
        <h2 className="mb-4 text-lg font-bold text-hw-text">Import Exportify CSV</h2>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
          className={`flex h-32 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed text-sm transition-colors ${dragging ? "border-led-blue bg-led-blue/10" : "border-hw-border text-hw-text-dim hover:border-hw-text-dim"}`}
          onClick={() => document.getElementById("csv-input")?.click()}
        >
          {file ? (
            <p className="text-hw-text">{file.name}</p>
          ) : (
            <p>Drag & drop CSV or click to browse</p>
          )}
          <input id="csv-input" type="file" accept=".csv" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className="mt-4 flex gap-2 justify-end">
          <button onClick={onClose} className="rounded px-4 py-2 text-sm text-hw-text-dim hover:text-hw-text">Cancel</button>
          <button
            onClick={handleImport}
            disabled={!file || loading}
            className="rounded-lg bg-led-blue px-4 py-2 text-sm font-medium text-hw-text hover:bg-led-blue/80 disabled:opacity-50"
          >
            {loading ? "Importing..." : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SpotifyImportModal({ onClose }: { onClose: () => void }) {
  const [playlists, setPlaylists] = useState<{ id: string; name: string; track_count?: number | null }[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    fetchSpotifyPlaylists()
      .then(setPlaylists)
      .catch((err) => toast.error(err.message))
      .finally(() => setFetching(false));
  }, []);

  async function handleImport() {
    if (!selected) return;
    setLoading(true);
    try {
      const result = await importSpotifyPlaylist(selected);
      toast.success(`Imported ${result.imported} tracks, ${result.jobs_created} jobs created`);
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-xl border border-hw-border bg-hw-surface p-6 shadow-2xl">
        <h2 className="mb-4 text-lg font-bold text-hw-text">Import Spotify Playlist</h2>
        {fetching ? (
          <p className="text-sm text-hw-text-dim">Loading playlists...</p>
        ) : playlists.length === 0 ? (
          <p className="text-sm text-hw-text-dim">No playlists found. Connect Spotify first.</p>
        ) : (
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full rounded-lg border border-hw-border bg-hw-raised px-3 py-2 text-sm text-hw-text"
          >
            <option value="">Select a playlist...</option>
            {playlists.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.track_count} tracks)</option>
            ))}
          </select>
        )}
        <div className="mt-4 flex gap-2 justify-end">
          <button onClick={onClose} className="rounded px-4 py-2 text-sm text-hw-text-dim hover:text-hw-text">Cancel</button>
          <button
            onClick={handleImport}
            disabled={!selected || loading}
            className="rounded-lg bg-led-green px-4 py-2 text-sm font-medium text-hw-text hover:bg-led-green/80 disabled:opacity-50"
          >
            {loading ? "Importing..." : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
