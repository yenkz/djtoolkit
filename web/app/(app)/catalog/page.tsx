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
  available: "bg-green-900 text-green-300",
  candidate: "bg-yellow-900 text-yellow-300",
  downloading: "bg-blue-900 text-blue-300",
  failed: "bg-red-900 text-red-300",
  duplicate: "bg-gray-700 text-gray-400",
};

const API_URL = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api`;

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
        <h1 className="text-xl font-bold text-white">Catalog</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCsvModal(true)}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
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
            className="rounded-lg border border-green-600 px-3 py-1.5 text-sm font-medium text-green-400 hover:bg-green-900/30"
          >
            Connect Spotify
          </button>
          <button
            onClick={() => setShowSpotifyModal(true)}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-300 hover:bg-gray-800"
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
            <div key={label} className="rounded-lg border border-gray-800 bg-gray-900 p-3">
              <p className="text-2xl font-bold text-white">{value}</p>
              <p className="text-xs text-gray-500">{label}</p>
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
          className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
        />
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
        >
          <option value="">All statuses</option>
          {["candidate", "downloading", "available", "failed", "duplicate"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs text-gray-500">
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
              <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-500">Loading...</td></tr>
            ) : tracks.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-500">No tracks found</td></tr>
            ) : tracks.map((t) => (
              <tr key={t.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                <td className="px-2 py-2.5 text-center">
                  {t.artwork_url ? (
                    <img
                      src={t.artwork_url}
                      alt=""
                      className="h-8 w-8 rounded object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className={`inline-flex h-8 w-8 items-center justify-center rounded ${t.cover_art_written ? "bg-indigo-900/50" : "bg-gray-800"}`}>
                      <svg className={`h-4 w-4 ${t.cover_art_written ? "text-indigo-400" : "text-gray-600"}`} fill="currentColor" viewBox="0 0 20 20">
                        <path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z" />
                      </svg>
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-white">{t.title}</td>
                <td className="px-4 py-2.5 text-gray-300">{t.artist}</td>
                <td className="px-4 py-2.5 text-gray-400">{t.album}</td>
                <td className="px-4 py-2.5">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[t.acquisition_status] ?? "bg-gray-700 text-gray-300"}`}>
                    {t.acquisition_status}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-gray-300 tabular-nums">
                  {t.tempo ? Math.round(t.tempo) : <span className="text-gray-600">—</span>}
                </td>
                <td className="px-3 py-2.5 text-gray-400 max-w-[140px] truncate" title={t.genres ?? ""}>
                  {t.genres || <span className="text-gray-600">—</span>}
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
                        className={`rounded px-1 py-0.5 text-xs ${val ? "bg-green-900 text-green-300" : "bg-gray-800 text-gray-600"}`}
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
                      className="rounded px-2 py-0.5 text-xs text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
                    >
                      {copiedId === t.id ? "Copied!" : "Copy path"}
                    </button>
                  ) : (
                    <span className="text-gray-600 text-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-gray-500">{total} tracks</p>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">Show</span>
            <select
              value={perPage}
              onChange={(e) => { setPerPage(Number(e.target.value)); setPage(1); }}
              className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-white focus:border-indigo-500 focus:outline-none"
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
              className="rounded px-3 py-1 text-sm text-gray-400 hover:text-white disabled:opacity-30"
            >
              Previous
            </button>
            <span className="text-sm text-gray-400">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="rounded px-3 py-1 text-sm text-gray-400 hover:text-white disabled:opacity-30"
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
      <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-2xl">
        <h2 className="mb-4 text-lg font-bold text-white">Import Exportify CSV</h2>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
          className={`flex h-32 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed text-sm transition-colors ${dragging ? "border-indigo-500 bg-indigo-900/20" : "border-gray-700 text-gray-500 hover:border-gray-500"}`}
          onClick={() => document.getElementById("csv-input")?.click()}
        >
          {file ? (
            <p className="text-white">{file.name}</p>
          ) : (
            <p>Drag & drop CSV or click to browse</p>
          )}
          <input id="csv-input" type="file" accept=".csv" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className="mt-4 flex gap-2 justify-end">
          <button onClick={onClose} className="rounded px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button
            onClick={handleImport}
            disabled={!file || loading}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
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
      <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-2xl">
        <h2 className="mb-4 text-lg font-bold text-white">Import Spotify Playlist</h2>
        {fetching ? (
          <p className="text-sm text-gray-400">Loading playlists...</p>
        ) : playlists.length === 0 ? (
          <p className="text-sm text-gray-400">No playlists found. Connect Spotify first.</p>
        ) : (
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white"
          >
            <option value="">Select a playlist...</option>
            {playlists.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.track_count} tracks)</option>
            ))}
          </select>
        )}
        <div className="mt-4 flex gap-2 justify-end">
          <button onClick={onClose} className="rounded px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button
            onClick={handleImport}
            disabled={!selected || loading}
            className="rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50"
          >
            {loading ? "Importing..." : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
