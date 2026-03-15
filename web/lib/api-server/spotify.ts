/**
 * Shared Spotify OAuth helpers: token retrieval, refresh, and search string
 * builder. Used by multiple Spotify-related API routes.
 */

import { createServiceClient } from "@/lib/supabase/service";
import { fernetDecrypt, fernetEncrypt } from "@/lib/api-server/fernet";

const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";

/**
 * Retrieve (and auto-refresh if needed) the user's decrypted Spotify access
 * token. Returns the plaintext access token or throws an error.
 */
export async function getSpotifyToken(userId: string): Promise<string> {
  const supabase = createServiceClient();

  const { data: row, error } = await supabase
    .from("users")
    .select(
      "spotify_access_token, spotify_refresh_token, spotify_token_expires_at"
    )
    .eq("id", userId)
    .single();

  if (error || !row) {
    throw new Error("User not found");
  }

  if (!row.spotify_access_token || !row.spotify_refresh_token) {
    throw new Error("Spotify not connected");
  }

  const expiresAt = new Date(row.spotify_token_expires_at).getTime();
  const now = Date.now();
  const bufferMs = 60_000; // refresh 60s before expiry

  // Token still valid — decrypt and return
  if (expiresAt - now > bufferMs) {
    return fernetDecrypt(row.spotify_access_token);
  }

  // Token expired or about to expire — refresh
  const refreshToken = fernetDecrypt(row.spotify_refresh_token);

  const clientId = process.env.SPOTIFY_CLIENT_ID!;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;

  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Spotify token refresh failed: ${resp.status} ${body}`);
  }

  const tokens = (await resp.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  const newExpiresAt = new Date(
    Date.now() + tokens.expires_in * 1000
  ).toISOString();

  const updatePayload: Record<string, string> = {
    spotify_access_token: fernetEncrypt(tokens.access_token),
    spotify_token_expires_at: newExpiresAt,
  };

  // Spotify may rotate the refresh token
  if (tokens.refresh_token) {
    updatePayload.spotify_refresh_token = fernetEncrypt(tokens.refresh_token);
  }

  await supabase.from("users").update(updatePayload).eq("id", userId);

  return tokens.access_token;
}

/**
 * Build a Soulseek-style search string from artist + title.
 *
 * Logic mirrors `djtoolkit/utils/search_string.py`:
 * - Take first artist (before semicolon)
 * - Strip feat./ft./vs. suffixes
 * - Remove parenthesized text from title
 * - Lowercase, remove special chars, collapse whitespace
 */
export function buildSearchString(artist: string, title: string): string {
  let a = artist.split(";")[0].trim();
  a = a.replace(/\s*(feat\.?|ft\.?|vs\.?).*$/i, "").trim();
  const t = title.replace(/\(.*?\)/g, "").trim();
  return `${a} ${t}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
