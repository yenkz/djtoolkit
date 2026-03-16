import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAuthError } from "@/lib/api-server/auth";
import { rateLimit, limiters } from "@/lib/api-server/rate-limit";
import { auditLog, getClientIp } from "@/lib/api-server/audit";
import { createServiceClient } from "@/lib/supabase/service";
import { jsonError } from "@/lib/api-server/errors";

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

  // Read and parse CSV
  const text = await file.text();
  const csvRows = parseCsv(text);

  if (csvRows.length === 0) {
    return jsonError("CSV file is empty or has no data rows", 400);
  }

  // Build track rows, filtering invalid rows
  const trackRows: TrackInsert[] = [];
  for (const row of csvRows) {
    const track = buildTrackRow(row, user.userId);
    if (track) trackRows.push(track);
  }

  if (trackRows.length === 0) {
    return jsonError(
      "No valid tracks found in CSV (missing spotify_uri column?)",
      400
    );
  }

  const supabase = createServiceClient();

  // Upsert tracks — ON CONFLICT (user_id, spotify_uri) DO NOTHING
  const { data: inserted, error: insertErr } = await supabase
    .from("tracks")
    .upsert(trackRows, {
      onConflict: "user_id,spotify_uri",
      ignoreDuplicates: true,
    })
    .select("id, title, artist, search_string, duration_ms, spotify_uri");

  if (insertErr) {
    return jsonError("Failed to import tracks", 500);
  }

  const importedTracks = inserted ?? [];
  const imported = importedTracks.length;
  const skippedDuplicates = trackRows.length - imported;

  // Optionally create download jobs for each imported track
  let jobsCreated = 0;
  const trackIds: number[] = importedTracks.map((t) => t.id as number);

  if (queueJobs && importedTracks.length > 0) {
    const jobRows = importedTracks.map((track) => ({
      user_id: user.userId,
      track_id: track.id,
      job_type: "download",
      payload: {
        track_id: track.id,
        search_string: track.search_string ?? "",
        artist: track.artist ?? "",
        title: track.title ?? "",
        duration_ms: track.duration_ms ?? 0,
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
