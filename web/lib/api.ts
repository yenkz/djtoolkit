import { createClient } from "./supabase/client";

const API_URL = "/api";

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
  preview_url?: string;
  already_owned?: boolean;
  key_normalized?: string;
  key?: number;
  mode?: number;
  energy?: number;
  created_at?: string;
}

export interface PreviewTrack {
  _key: string;
  source: string;
  title: string;
  artist: string;
  artists?: string;
  album?: string;
  year?: number;
  duration_ms?: number;
  genres?: string;
  spotify_uri?: string;
  preview_url?: string;
  artwork_url?: string;
  search_string?: string;
  already_owned: boolean;
  release_date?: string;
  isrc?: string;
  popularity?: number;
  record_label?: string;
  danceability?: number;
  energy?: number;
  key?: number;
  loudness?: number;
  mode?: number;
  speechiness?: number;
  acousticness?: number;
  instrumentalness?: number;
  liveness?: number;
  valence?: number;
  tempo?: number;
  time_signature?: number;
  explicit?: boolean;
  added_by?: string;
  added_at?: string;
}

export interface PreviewResult {
  tracks: PreviewTrack[];
  total: number;
  has_more?: boolean;
  next_offset?: number | null;
}

export interface ConfirmResult {
  imported: number;
  skipped_duplicates: number;
  jobs_created: number;
  track_ids: number[];
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
  has_more?: boolean;
  next_offset?: number | null;
}

export async function fetchTracks(params: {
  page?: number;
  per_page?: number;
  status?: string;
  search?: string;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
  analyzed?: boolean;
}): Promise<{ tracks: Track[]; total: number; page: number }> {
  const qs = new URLSearchParams();
  if (params.page) qs.set("page", String(params.page));
  if (params.per_page) qs.set("per_page", String(params.per_page));
  if (params.status) qs.set("status", params.status);
  if (params.search) qs.set("search", params.search);
  if (params.sort_by) qs.set("sort_by", params.sort_by);
  if (params.sort_dir) qs.set("sort_dir", params.sort_dir);
  if (params.analyzed !== undefined) qs.set("analyzed", String(params.analyzed));
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
  track_artwork_url: string | null;
  track_album: string | null;
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

export async function fetchTrackJobs(
  trackId: number
): Promise<PipelineJobList> {
  const qs = new URLSearchParams();
  qs.set("track_id", String(trackId));
  qs.set("per_page", "200");
  const res = await apiClient(`/pipeline/jobs/history?${qs}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function retryPipelineJobs(params: {
  job_ids?: string[];
  filter_status?: string;
  filter_job_type?: string;
}): Promise<{ retried: number }> {
  const res = await apiClient("/pipeline/jobs/retry", {
    method: "POST",
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ── Pipeline Monitor types ───────────────────────────────────── */

export type AcquisitionStatus =
  | "candidate"
  | "searching"
  | "found"
  | "not_found"
  | "queued"
  | "downloading"
  | "failed"
  | "paused";

export interface PipelineTrack {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  artwork_url: string | null;
  acquisition_status: AcquisitionStatus;
  search_string: string | null;
  search_results_count: number | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface PipelineMonitorStatus {
  candidate: number;
  searching: number;
  found: number;
  not_found: number;
  queued: number;
  downloading: number;
  failed: number;
  paused: number;
  agents: { id: string; machine_name: string; last_seen_at: string; capabilities: string[] }[];
}

export interface PipelineTrackList {
  tracks: PipelineTrack[];
  total: number;
  page: number;
  per_page: number;
}

export async function fetchPipelineMonitorStatus(): Promise<PipelineMonitorStatus> {
  const res = await apiClient("/pipeline/status");
  if (!res.ok) throw new Error("Failed to fetch pipeline status");
  return res.json();
}

export async function fetchPipelineTracks(params: {
  page?: number;
  per_page?: number;
  status?: AcquisitionStatus;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
  search?: string;
}): Promise<PipelineTrackList> {
  const sp = new URLSearchParams();
  if (params.page) sp.set("page", String(params.page));
  if (params.per_page) sp.set("per_page", String(params.per_page));
  if (params.status) sp.set("status", params.status);
  if (params.sort_by) sp.set("sort_by", params.sort_by);
  if (params.sort_dir) sp.set("sort_dir", params.sort_dir);
  if (params.search) sp.set("search", params.search);
  const res = await apiClient(`/pipeline/tracks?${sp}`);
  if (!res.ok) throw new Error("Failed to fetch pipeline tracks");
  return res.json();
}

export async function bulkPipelineAction(
  action: "retry_failed" | "delete_failed" | "delete_candidates" | "pause_candidates" | "resume_paused" | "queue_candidates" | "delete_selected",
  trackIds?: number[],
): Promise<{ updated?: number; deleted?: number; created?: number }> {
  const payload: { action: string; track_ids?: number[] } = { action };
  if (trackIds) payload.track_ids = trackIds;
  const res = await apiClient("/pipeline/tracks/bulk", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function retryPipelineTrack(
  trackId: number,
  searchString?: string
): Promise<PipelineTrack> {
  const body = searchString ? { search_string: searchString } : {};
  const res = await apiClient(`/pipeline/tracks/${trackId}/retry`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to retry track");
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

// ── Agent Commands ───────────────────────────────────────────────────────────

export interface AgentCommand {
  id: string;
  command_type: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export async function sendAgentCommand(
  agentId: string,
  commandType: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await apiClient("/agents/commands", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, command_type: commandType, payload }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function getAgentCommandResult(
  commandId: string,
): Promise<AgentCommand> {
  const res = await apiClient(`/agents/commands/${commandId}`);
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

// ── Folder Import ────────────────────────────────────────────────────────────

export async function importFolder(
  agentId: string,
  path: string,
  recursive = true,
): Promise<{ id: string }> {
  const res = await apiClient("/catalog/import/folder", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, path, recursive }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export interface ReviewDecision {
  track_id: number;
  action: "keep" | "skip" | "replace";
  duplicate_track_id?: number;
}

export async function reviewDuplicates(
  decisions: ReviewDecision[],
): Promise<{ kept: number; skipped: number; replaced: number; errors: number }> {
  const res = await apiClient("/catalog/import/folder/review", {
    method: "POST",
    body: JSON.stringify({ decisions }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export interface FolderImportReport {
  total: number;
  fully_enriched: number;
  missing: Record<string, number>;
  tracks: Array<{
    id: number;
    title: string;
    artist: string;
    local_path: string;
    acquisition_status: string;
    missing_fields: string[];
  }>;
}

export async function getFolderImportReport(
  jobId: string,
): Promise<FolderImportReport> {
  const res = await apiClient(`/catalog/import/folder/${jobId}/report`);
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

// ─── Onboarding API functions ─────────────────────────────────────────────────

export async function importSpotifyPlaylistNoJobs(
  playlistId: string
): Promise<ImportResult> {
  const combined: ImportResult = {
    imported: 0,
    skipped_duplicates: 0,
    jobs_created: 0,
    track_ids: [],
  };

  let offset = 0;
  while (true) {
    const res = await apiClient(
      `/catalog/import/spotify?queue_jobs=false&offset=${offset}`,
      { method: "POST", body: JSON.stringify({ playlist_id: playlistId }) }
    );
    if (!res.ok) throw new Error(await extractError(res));
    const chunk: ImportResult = await res.json();

    combined.imported += chunk.imported;
    combined.skipped_duplicates += chunk.skipped_duplicates;
    combined.jobs_created += chunk.jobs_created;
    combined.track_ids.push(...chunk.track_ids);

    if (!chunk.has_more || chunk.next_offset == null) break;
    offset = chunk.next_offset;
  }

  return combined;
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
  tracks_found?: number; // total unfiltered tracks from TrackID.dev (set on completion)
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

export async function previewImportCsv(file: File): Promise<PreviewResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await apiClientForm(
    `/catalog/import/csv?preview=true`,
    form
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function previewImportSpotify(
  playlistId: string
): Promise<PreviewResult> {
  const combined: PreviewResult = { tracks: [], total: 0 };

  let offset = 0;
  while (true) {
    const res = await apiClient(
      `/catalog/import/spotify?preview=true&offset=${offset}`,
      { method: "POST", body: JSON.stringify({ playlist_id: playlistId }) }
    );
    if (!res.ok) throw new Error(await extractError(res));
    const chunk: PreviewResult = await res.json();

    combined.tracks.push(...chunk.tracks);
    combined.total += chunk.total;

    if (!chunk.has_more || chunk.next_offset == null) break;
    offset = chunk.next_offset;
  }

  return combined;
}

export async function submitTrackIdPreview(
  url: string
): Promise<{ job_id: string } | PreviewResult> {
  const res = await apiClient(
    `/catalog/import/trackid?preview=true`,
    { method: "POST", body: JSON.stringify({ url }) }
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function confirmImport(
  tracks: PreviewTrack[],
  queueJobs: boolean
): Promise<ConfirmResult> {
  const res = await apiClient("/catalog/import/confirm", {
    method: "POST",
    body: JSON.stringify({ tracks, queue_jobs: queueJobs }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

// ─── DJ Software Import/Export ────────────────────────────────────────────────

export interface ParseResult {
  format: string;
  tracks_imported: number;
  tracks_parsed: number;
  playlists_found: number;
  warnings: string[];
  track_ids: number[];
}

export async function parseCollection(file: File): Promise<ParseResult> {
  // Upload directly to Hetzner API to bypass Vercel's 4.5MB body size limit
  const hetznerUrl = process.env.NEXT_PUBLIC_DJTOOLKIT_API_URL;
  if (!hetznerUrl) throw new Error("NEXT_PUBLIC_DJTOOLKIT_API_URL not configured");

  const token = await getToken();
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${hetznerUrl}/parse`, {
    method: "POST",
    body: form,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const detail = await extractError(res);
    throw new Error(detail);
  }
  return res.json();
}

export async function exportCollection(
  format: "traktor" | "rekordbox" | "csv",
  genre?: string,
): Promise<void> {
  const qs = genre ? `?genre=${encodeURIComponent(genre)}` : "";
  const res = await apiClient(`/collection/export/${format}${qs}`);
  if (!res.ok) {
    const text = await res.text();
    let detail: string;
    try {
      detail = JSON.parse(text).detail ?? text;
    } catch {
      detail = text;
    }
    throw new Error(detail);
  }
  // Trigger browser file download
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const filenameMatch = disposition.match(/filename=([^\s;]+)/);
  const filename =
    filenameMatch?.[1] ||
    `export.${format === "traktor" ? "nml" : format === "rekordbox" ? "xml" : "csv"}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function analyzeTracksBulk(
  trackIds: number[],
  force?: boolean,
): Promise<{ created: number; skipped: number; cover_art_created: number }> {
  const res = await apiClient("/catalog/analyze", {
    method: "POST",
    body: JSON.stringify({ track_ids: trackIds, force: force ?? false }),
  });
  if (!res.ok) throw new Error(await extractError(res));
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
  // Batch in chunks of 100 to avoid URL length limits
  const all: Track[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const params = batch.map((id) => `id=${id}`).join("&");
    const res = await apiClient(`/catalog/tracks?${params}&per_page=1000`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    all.push(...(data.tracks as Track[]));
  }
  return all;
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface UserSettings {
  display_name?: string;
  downloads_dir?: string;
  library_dir?: string;
  soulseek_username?: string;
  soulseek_password?: string;
  soulseek_enabled?: boolean;
  min_score?: number;
  duration_tolerance_ms?: number;
  search_timeout_sec?: number;
  fingerprint_enabled?: boolean;
  acoustid_api_key?: string;
  loudnorm_target_lufs?: number;
  loudnorm_enabled?: boolean;
  coverart_sources?: string[];
  coverart_enabled?: boolean;
  export_formats?: string[];
  export_output_path?: string;
  analysis_essentia_model_path?: string;
  analysis_enabled?: boolean;
  push_notifications_enabled?: boolean;
  trackid_confidence_threshold?: number;
}

export async function fetchSettings(): Promise<{
  settings: UserSettings;
  email: string | null;
}> {
  const res = await apiClient("/settings");
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function updateSettings(
  partial: Partial<UserSettings>,
): Promise<{ settings: UserSettings }> {
  const res = await apiClient("/settings", {
    method: "PUT",
    body: JSON.stringify(partial),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function clearLibrary(): Promise<{ deleted: number }> {
  const res = await apiClient("/settings/clear-library", { method: "POST" });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}

export async function deleteAccount(): Promise<void> {
  const res = await apiClient("/settings/account", { method: "DELETE" });
  if (!res.ok) throw new Error(await extractError(res));
}
