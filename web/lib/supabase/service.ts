import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client for server-side API route handlers.
 * Bypasses RLS — use only in trusted server code.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  }
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set — server routes can't bypass RLS",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
