import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Ensure a row exists in public.users for the authenticated user.
 * Uses upsert (on conflict do nothing) so it's safe to call on every login.
 */
async function ensureUserRow(
  supabase: ReturnType<typeof createServerClient>
) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return;

  const service = createServiceClient();
  await service.from("users").upsert(
    { id: user.id, email: user.email },
    { onConflict: "id", ignoreDuplicates: true }
  );
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Support both legacy `next` param and new `return_to` param.
  // If return_to=/import, append ?spotify=connected so the wizard
  // knows to auto-expand the Spotify section.
  const returnTo = searchParams.get("return_to");
  const next = searchParams.get("next") ?? "/catalog";

  const destination = returnTo
    ? returnTo === "/import"
      ? "/import?spotify=connected"
      : returnTo
    : next;

  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );

  // Handle email confirmation (token_hash flow)
  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash,
      type: type as "signup" | "email",
    });
    if (!error) {
      await ensureUserRow(supabase);
      return NextResponse.redirect(`${origin}${destination}`);
    }
  }

  // Handle OAuth / PKCE flow (code exchange)
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      await ensureUserRow(supabase);
      return NextResponse.redirect(`${origin}${destination}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
