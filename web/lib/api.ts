import { createClient } from "./supabase/client";

const API_URL = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api`;

async function getToken(): Promise<string | null> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

async function extractError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return json.detail ?? text;
  } catch {
    return text;
  }
}

export async function apiClient(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const token = await getToken();
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
}

export async function apiClientForm(
  path: string,
  body: FormData
): Promise<Response> {
  const token = await getToken();
  return fetch(`${API_URL}${path}`, {
    method: "POST",
    body,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

export interface Track {
  id: number;
  title: string;
  artist: string;
  album: string;
  acquisition_status: string;
  fingerprinted: number;
  enriched_spotify: number;
  enriched_audio: number;
  metadata_written: number;
  cover_art_written: number;
  in_library: number;
  local_path?: string;
  year?: number;
  genres?: string;
  tempo?: number;
  artwork_url?: string;
  spotify_uri?: string;
  already_owned?: boolean;
}

export interface CatalogStats {
  total: number;
  by_status: Record<string, number>;
  flags: Record<string, number>;
}

export interface ImportResult {
  imported: number;
  skipped_duplicates: number;
  jobs_created: number;
  track_ids: number[];
}

export async function fetchTracks(params: {
  page?: number;
  per_page?: number;
  status?: string;
  search?: string;
}): Promise<{ tracks: Track[]; total: number; page: number }> {
  const qs = new URLSearchParams();
  if (params.page) qs.set("page", String(params.page));
  if (params.per_page) qs.set("per_page", String(params.per_page));
  if (params.status) qs.set("status", params.status);
  if (params.search) qs.set("search", params.search);
  const res = await apiClient(`/catalog/tracks?${qs}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchStats(): Promise<CatalogStats> {
  const res = await apiClient("/catalog/stats");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function importCsv(file: File): Promise<ImportResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await apiClientForm("/catalog/import/csv", form);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSpotifyPlaylists(): Promise<
  { id: string; name: string; track_count?: number | null; owner?: string; image_url?: string; is_owner?: boolean }[]
> {
  const res = await apiClient("/catalog/import/spotify/playlists");
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function importSpotifyPlaylist(
  playlistId: string
): Promise<ImportResult> {
  const res = await apiClient("/catalog/import/spotify", {
    method: "POST",
    body: JSON.stringify({ playlist_id: playlistId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function disconnectSpotify(): Promise<void> {
  await apiClient("/auth/spotify/disconnect", { method: "POST" });
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export interface PipelineStatus {
  pending: number;
  running: number;
  agents: {
    id: string;
    machine_name: string;
    last_seen_at: string;
    capabilities: string[];
  }[];
}

export async function fetchPipelineStatus(): Promise<PipelineStatus> {
  const res = await apiClient("/pipeline/status");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export interface PipelineJob {
  id: string;
  job_type: string;
  status: string;
  track_id: number | null;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  retry_count: number;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
  track_title: string | null;
  track_artist: string | null;
}

export interface PipelineJobList {
  jobs: PipelineJob[];
  total: number;
  page: number;
  per_page: number;
}

export async function fetchPipelineJobs(params: {
  page?: number;
  per_page?: number;
  status?: string;
  job_type?: string;
}): Promise<PipelineJobList> {
  const qs = new URLSearchParams();
  if (params.page) qs.set("page", String(params.page));
  if (params.per_page) qs.set("per_page", String(params.per_page));
  if (params.status) qs.set("status", params.status);
  if (params.job_type) qs.set("job_type", params.job_type);
  const res = await apiClient(`/pipeline/jobs/history?${qs}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ─── Agents ───────────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  machine_name: string;
  last_seen_at: string;
  capabilities: string[];
  created_at: string;
}

export async function fetchAgents(): Promise<Agent[]> {
  const res = await apiClient("/agents");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function registerAgent(
  machineName: string
): Promise<{ api_key: string; agent: Agent }> {
  const res = await apiClient("/agents/register", {
    method: "POST",
    body: JSON.stringify({ machine_name: machineName }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteAgent(id: string): Promise<void> {
  await apiClient(`/agents/${id}`, { method: "DELETE" });
}

// ─── Onboarding API functions ─────────────────────────────────────────────────

export async function importSpotifyPlaylistNoJobs(
  playlistId: string
): Promise<ImportResult> {
  const res = await apiClient(
    `/catalog/import/spotify?queue_jobs=false`,
    { method: "POST", body: JSON.stringify({ playlist_id: playlistId }) }
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function submitTrackIdJob(url: string): Promise<{ job_id: string }> {
  const res = await apiClient(
    `/catalog/import/trackid?queue_jobs=false`,
    { method: "POST", body: JSON.stringify({ url }) }
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export interface TrackIdJobStatus {
  status: string;       // queued | submitting | fingerprinting | matching | inserting | completed | failed
  progress: number;     // 0–100
  step: string;         // human-readable current step
  error: string | null;
  result: ImportResult | null;
}

export async function getTrackIdJobStatus(jobId: string): Promise<TrackIdJobStatus> {
  const res = await apiClient(`/catalog/import/trackid/${jobId}/status`);
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function importCsvNoJobs(file: File): Promise<ImportResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await apiClientForm(
    `/catalog/import/csv?queue_jobs=false`,
    form
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function bulkCreateJobs(trackIds: number[]): Promise<{ created: number }> {
  const res = await apiClient("/pipeline/jobs/bulk", {
    method: "POST",
    body: JSON.stringify({ track_ids: trackIds }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function bulkDeleteTracks(trackIds: number[]): Promise<{ deleted: number }> {
  const res = await apiClient("/catalog/tracks/bulk", {
    method: "DELETE",
    body: JSON.stringify({ track_ids: trackIds }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchCandidateTracks(): Promise<Track[]> {
  const res = await apiClient("/catalog/tracks?status=candidate&per_page=1000");
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.tracks as Track[];
}

export async function fetchTracksByIds(ids: number[]): Promise<Track[]> {
  if (ids.length === 0) return [];
  const params = ids.map((id) => `id=${id}`).join("&");
  const res = await apiClient(`/catalog/tracks?${params}&per_page=1000`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.tracks as Track[];
}
