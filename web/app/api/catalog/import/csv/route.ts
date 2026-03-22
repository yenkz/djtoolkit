import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";
import { getUserSettings, getJobSettings } from "@/lib/api-server/job-settings";

const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB — Vercel request body limit

// ─── CSV column → DB column mapping ────────────────────────────────────────

const CSV_TO_DB: Record<string, string> = {
  "Track URI": "spotify_uri",
  "Track Name": "title",
  "Album Name": "album",
  "Artist Name(s)": "artists",
  "Release Date": "release_date",
  "Duration (ms)": "duration_ms",
  Popularity: "popularity",
  Genres: "genres",
  "Record Label": "record_label",
  Danceability: "danceability",
  Energy: "energy",
  Key: "key",
  Loudness: "loudness",
  Mode: "mode",
  Speechiness: "speechiness",
  Acousticness: "acousticness",
  Instrumentalness: "instrumentalness",
  Liveness: "liveness",
  Valence: "valence",
  Tempo: "tempo",
  "Time Signature": "time_signature",
  Explicit: "explicit",
  "Added By": "added_by",
  "Added At": "added_at",
};

const INT_COLUMNS = new Set([
  "duration_ms",
  "popularity",
  "key",
  "mode",
  "time_signature",
]);

const FLOAT_COLUMNS = new Set([
  "danceability",
  "energy",
  "loudness",
  "speechiness",
  "acousticness",
  "instrumentalness",
  "liveness",
  "valence",
  "tempo",
]);

// ─── Header aliases for non-English Spotify exports ─────────────────────────
// Spotify data exports use the account's locale for column headers.
// Map known translations → canonical English names used by CSV_TO_DB.

const HEADER_ALIASES: Record<string, string> = {
  // Spanish
  "URI de la canción": "Track URI",
  "Nombre de la canción": "Track Name",
  "Nombre(s) del artista": "Artist Name(s)",
  "Nombre del álbum": "Album Name",
  "Fecha de lanzamiento del álbum": "Release Date",
  "Duración de la canción (ms)": "Duration (ms)",
  "Explícito": "Explicit",
  "Popularidad": "Popularity",
  "Añadido por": "Added By",
  "Añadido en": "Added At",
  // French
  "URI de la piste": "Track URI",
  "Nom de la piste": "Track Name",
  "Nom(s) de l'artiste": "Artist Name(s)",
  "Nom de l'album": "Album Name",
  "Date de sortie de l'album": "Release Date",
  "Durée de la piste (ms)": "Duration (ms)",
  "Explicite": "Explicit",
  "Popularité": "Popularity",
  "Ajouté par": "Added By",
  "Ajouté le": "Added At",
  // Portuguese
  "URI da faixa": "Track URI",
  "Nome da faixa": "Track Name",
  "Nome(s) do(s) artista(s)": "Artist Name(s)",
  "Nome do álbum": "Album Name",
  "Data de lançamento do álbum": "Release Date",
  "Duração da faixa (ms)": "Duration (ms)",
  "Explícito": "Explicit",
  "Popularidade": "Popularity",
  "Adicionado por": "Added By",
  "Adicionado em": "Added At",
  // German
  "Titel-URI": "Track URI",
  "Titelname": "Track Name",
  "Name(n) des/der Künstler(s)": "Artist Name(s)",
  "Albumname": "Album Name",
  "Veröffentlichungsdatum des Albums": "Release Date",
  "Titeldauer (ms)": "Duration (ms)",
  "Explizit": "Explicit",
  "Popularität": "Popularity",
  "Hinzugefügt von": "Added By",
  "Hinzugefügt am": "Added At",
};

/**
 * Normalize CSV headers to canonical English names.
 * If English headers are already present, returns rows as-is.
 * Falls back to detecting the URI column from data patterns.
 */
function normalizeHeaders(
  csvRows: Record<string, string>[]
): Record<string, string>[] {
  if (csvRows.length === 0) return csvRows;
  const headers = Object.keys(csvRows[0]);
  if (headers.includes("Track URI")) return csvRows;

  const remap: Record<string, string> = {};
  for (const h of headers) {
    if (HEADER_ALIASES[h]) remap[h] = HEADER_ALIASES[h];
  }

  // Fallback: detect URI column from data (language-agnostic)
  if (!Object.values(remap).includes("Track URI")) {
    for (const h of headers) {
      if ((csvRows[0][h] ?? "").startsWith("spotify:track:")) {
        remap[h] = "Track URI";
        break;
      }
    }
  }

  if (Object.keys(remap).length === 0) return csvRows;

  return csvRows.map((row) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      out[remap[k] ?? k] = v;
    }
    return out;
  });
}

// ─── Search string builder ──────────────────────────────────────────────────

function buildSearchString(artist: string, title: string): string {
  // Take first artist before semicolon, strip feat./ft./vs. and parentheses
  let a = artist.split(";")[0].trim();
  a = a.replace(/\s*(feat\.?|ft\.?|vs\.?).*$/i, "").trim();
  const t = title.replace(/\(.*?\)/g, "").trim();
  return `${a} ${t}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Minimal CSV parser ─────────────────────────────────────────────────────

/**
 * Parse a CSV string into an array of objects keyed by header row values.
 * Handles double-quoted fields (including embedded commas and escaped quotes).
 */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = splitCsvLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Split a single CSV line into fields, respecting double-quoted fields.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        // Peek ahead: "" is an escaped quote within a field
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }

  fields.push(current);
  return fields;
}

// ─── Track row builder ──────────────────────────────────────────────────────

interface TrackInsert {
  user_id: string;
  spotify_uri: string;
  title: string | null;
  artist: string | null;
  artists: string | null;
  album: string | null;
  year: number | null;
  release_date: string | null;
  duration_ms: number | null;
  popularity: number | null;
  genres: string | null;
  record_label: string | null;
  danceability: number | null;
  energy: number | null;
  key: number | null;
  loudness: number | null;
  mode: number | null;
  speechiness: number | null;
  acousticness: number | null;
  instrumentalness: number | null;
  liveness: number | null;
  valence: number | null;
  tempo: number | null;
  time_signature: number | null;
  explicit: boolean | null;
  added_by: string | null;
  added_at: string | null;
  search_string: string;
  source: string;
  acquisition_status: string;
}

function buildTrackRow(
  csvRow: Record<string, string>,
  userId: string
): TrackInsert | null {
  // Map CSV headers to DB columns
  const mapped: Record<string, string> = {};
  for (const [csvCol, dbCol] of Object.entries(CSV_TO_DB)) {
    if (csvRow[csvCol] !== undefined) {
      mapped[dbCol] = csvRow[csvCol];
    }
  }

  const spotifyUri = mapped["spotify_uri"]?.trim();
  if (!spotifyUri) return null;

  const artists = mapped["artists"]?.trim() || null;
  // Derive primary artist: first name before ";" (Exportify uses ";" as separator)
  const artist = artists ? artists.split(";")[0].trim() || null : null;
  const title = mapped["title"]?.trim() || null;

  // Derive year from release_date (first 4 chars)
  const releaseDate = mapped["release_date"]?.trim() || null;
  const year =
    releaseDate && releaseDate.length >= 4
      ? parseInt(releaseDate.slice(0, 4), 10) || null
      : null;

  // Cast integer columns
  const castInt = (val: string | undefined): number | null => {
    if (!val || val.trim() === "") return null;
    const n = parseInt(val, 10);
    return isNaN(n) ? null : n;
  };

  // Cast float columns
  const castFloat = (val: string | undefined): number | null => {
    if (!val || val.trim() === "") return null;
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  };

  // Cast boolean (Exportify exports "True"/"False" or "true"/"false")
  const castBool = (val: string | undefined): boolean | null => {
    if (!val || val.trim() === "") return null;
    const lower = val.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    return null;
  };

  const searchString = buildSearchString(artist ?? "", title ?? "");

  return {
    user_id: userId,
    spotify_uri: spotifyUri,
    title,
    artist,
    artists,
    album: mapped["album"]?.trim() || null,
    year,
    release_date: releaseDate,
    duration_ms: castInt(mapped["duration_ms"]),
    popularity: castInt(mapped["popularity"]),
    genres: mapped["genres"]?.trim() || null,
    record_label: mapped["record_label"]?.trim() || null,
    danceability: castFloat(mapped["danceability"]),
    energy: castFloat(mapped["energy"]),
    key: castInt(mapped["key"]),
    loudness: castFloat(mapped["loudness"]),
    mode: castInt(mapped["mode"]),
    speechiness: castFloat(mapped["speechiness"]),
    acousticness: castFloat(mapped["acousticness"]),
    instrumentalness: castFloat(mapped["instrumentalness"]),
    liveness: castFloat(mapped["liveness"]),
    valence: castFloat(mapped["valence"]),
    tempo: castFloat(mapped["tempo"]),
    time_signature: castInt(mapped["time_signature"]),
    explicit: castBool(mapped["explicit"]),
    added_by: mapped["added_by"]?.trim() || null,
    added_at: mapped["added_at"]?.trim() || null,
    search_string: searchString,
    source: "exportify",
    acquisition_status: "candidate",
  };

  // Suppress unused-variable warnings for column sets used in type narrowing
  void INT_COLUMNS;
  void FLOAT_COLUMNS;
}

// ─── Route handler ──────────────────────────────────────────────────────────

/**
 * POST /api/catalog/import/csv
 *
 * Import an Exportify CSV file. Accepts multipart/form-data with a "file" field.
 *
 * Query params:
 *   - queue_jobs (default "true") — create pipeline_jobs for each inserted track
 *
 * Returns 201: { imported, skipped_duplicates, jobs_created, track_ids }
 */
export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, limiters.import);
  if (rl) return rl;

  const user = await getAuthUser(request);
  if (isAuthError(user)) return user;

  const { searchParams } = request.nextUrl;
  const queueJobs = searchParams.get("queue_jobs") !== "false";
  const preview = searchParams.get("preview") === "true";

  const supabase = createServiceClient();

  // Parse multipart form data
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError("Failed to parse multipart form data", 400);
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return jsonError("Missing 'file' field in form data", 400);
  }

  // Validate file extension
  const filename = file.name ?? "upload";
  if (!filename.toLowerCase().endsWith(".csv")) {
    return jsonError("File must be a .csv file", 400);
  }

  // Validate file size
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return jsonError("File exceeds maximum size of 4 MB", 400);
  }

  // Validate content type (allow text/csv, application/csv, text/plain, octet-stream)
  const contentType = file.type ?? "";
  const allowedTypes = [
    "text/csv",
    "application/csv",
    "text/plain",
    "application/octet-stream",
    "",
  ];
  if (!allowedTypes.some((t) => contentType.startsWith(t))) {
    return jsonError(
      "Invalid content type. Expected text/csv or application/csv",
      400
    );
  }

  // Read and parse CSV — strip UTF-8 BOM that Exportify includes
  const text = (await file.text()).replace(/^\uFEFF/, "");
  const rawRows = parseCsv(text);

  if (rawRows.length === 0) {
    return jsonError("CSV file is empty or has no data rows", 400);
  }

  // Normalize non-English headers (e.g. Spanish Spotify exports) to English
  const csvRows = normalizeHeaders(rawRows);

  // Build track rows, filtering invalid rows
  const trackRows: TrackInsert[] = [];
  for (const row of csvRows) {
    const track = buildTrackRow(row, user.userId);
    if (track) trackRows.push(track);
  }

  if (trackRows.length === 0) {
    const headers = Object.keys(rawRows[0] ?? {}).slice(0, 5).join(", ");
    return jsonError(
      `No valid tracks found in CSV. Headers found: ${headers}…`,
      400
    );
  }

  if (preview) {
    // Check already_owned: find existing available tracks with matching spotify_uri
    const spotifyUris = trackRows.map((r) => r.spotify_uri).filter(Boolean) as string[];
    const ownedUris = new Set<string>();
    for (let i = 0; i < spotifyUris.length; i += 500) {
      const batch = spotifyUris.slice(i, i + 500);
      const { data: owned } = await supabase
        .from("tracks")
        .select("spotify_uri")
        .eq("user_id", user.userId)
        .eq("acquisition_status", "available")
        .in("spotify_uri", batch);
      for (const row of owned ?? []) {
        if (row.spotify_uri) ownedUris.add(row.spotify_uri);
      }
    }

    const previewTracks = trackRows.map((r) => ({
      _key: r.spotify_uri as string,
      source: r.source as string,
      title: (r.title as string) ?? "",
      artist: (r.artist as string) ?? "",
      artists: r.artists as string | undefined,
      album: r.album as string | undefined,
      year: r.year as number | undefined,
      duration_ms: r.duration_ms as number | undefined,
      genres: r.genres as string | undefined,
      spotify_uri: r.spotify_uri as string | undefined,
      artwork_url: null as string | null,
      search_string: r.search_string as string,
      already_owned: ownedUris.has(r.spotify_uri as string),
      release_date: r.release_date as string | undefined,
      isrc: null as string | null,
      popularity: r.popularity as number | undefined,
      record_label: r.record_label as string | undefined,
      danceability: r.danceability as number | undefined,
      energy: r.energy as number | undefined,
      key: r.key as number | undefined,
      loudness: r.loudness as number | undefined,
      mode: r.mode as number | undefined,
      speechiness: r.speechiness as number | undefined,
      acousticness: r.acousticness as number | undefined,
      instrumentalness: r.instrumentalness as number | undefined,
      liveness: r.liveness as number | undefined,
      valence: r.valence as number | undefined,
      tempo: r.tempo as number | undefined,
      time_signature: r.time_signature as number | undefined,
      explicit: r.explicit as boolean | undefined,
      added_by: r.added_by as string | undefined,
      added_at: r.added_at as string | undefined,
    }));

    return NextResponse.json(
      { tracks: previewTracks, total: previewTracks.length },
      { status: 200 }
    );
  }

  // Upsert tracks — ON CONFLICT (user_id, spotify_uri) DO NOTHING
  const { error: insertErr } = await supabase
    .from("tracks")
    .upsert(trackRows, {
      onConflict: "user_id,spotify_uri",
      ignoreDuplicates: true,
    });

  if (insertErr) {
    return jsonError("Failed to import tracks", 500);
  }

  // Fetch all tracks matching the CSV's spotify_uris (both new and pre-existing)
  // so the review step always shows them.
  const spotifyUris = trackRows.map((r) => r.spotify_uri);
  const allTracks: { id: number; title: string | null; artist: string | null; search_string: string; duration_ms: number | null; spotify_uri: string; acquisition_status: string }[] = [];
  for (let i = 0; i < spotifyUris.length; i += 500) {
    const batch = spotifyUris.slice(i, i + 500);
    const { data } = await supabase
      .from("tracks")
      .select("id, title, artist, search_string, duration_ms, spotify_uri, acquisition_status")
      .eq("user_id", user.userId)
      .in("spotify_uri", batch);
    if (data) allTracks.push(...data);
  }

  // Count how many are candidates (newly inserted) vs already processed
  const imported = allTracks.filter((t) => t.acquisition_status === "candidate").length;
  const skippedDuplicates = trackRows.length - imported;

  // Optionally create download jobs for newly imported (candidate) tracks
  let jobsCreated = 0;
  const trackIds: number[] = allTracks.map((t) => t.id);
  const candidateTracks = allTracks.filter((t) => t.acquisition_status === "candidate");

  if (queueJobs && candidateTracks.length > 0) {
    const userSettings = await getUserSettings(supabase, user.userId);
    const downloadSettings = getJobSettings(userSettings, "download");

    const jobRows = candidateTracks.map((track) => ({
      user_id: user.userId,
      track_id: track.id,
      job_type: "download",
      payload: {
        track_id: track.id,
        search_string: track.search_string ?? "",
        artist: track.artist ?? "",
        title: track.title ?? "",
        duration_ms: track.duration_ms ?? 0,
        ...(Object.keys(downloadSettings).length > 0 && { settings: downloadSettings }),
      },
    }));

    const { data: createdJobs, error: jobErr } = await supabase
      .from("pipeline_jobs")
      .insert(jobRows)
      .select("id");

    if (jobErr) {
      console.warn("Failed to create pipeline jobs after CSV import:", jobErr.message);
    } else {
      jobsCreated = createdJobs?.length ?? 0;
    }
  }

  await auditLog(user.userId, "track.import.csv", {
    resourceType: "track",
    details: {
      filename,
      rows_parsed: csvRows.length,
      imported,
      skipped_duplicates: skippedDuplicates,
      jobs_created: jobsCreated,
    },
    ipAddress: getClientIp(request),
  });

  return NextResponse.json(
    {
      imported,
      skipped_duplicates: skippedDuplicates,
      jobs_created: jobsCreated,
      track_ids: trackIds,
    },
    { status: 201 }
  );
}
