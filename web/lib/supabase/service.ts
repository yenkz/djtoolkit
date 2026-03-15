import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client for server-side API route handlers.
 * Bypasses RLS — use only in trusted server code.
 */
export function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
