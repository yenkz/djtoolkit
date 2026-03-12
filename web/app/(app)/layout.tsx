import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Sidebar from "@/components/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // First-run detection: redirect to onboarding if not yet completed.
  // Primary gate: onboarding_completed flag in user_metadata.
  // Fallback for pre-flag users: check track count only if flag is absent.
  const onboardingCompleted = user.user_metadata?.onboarding_completed === true;
  if (!onboardingCompleted) {
    const flagAbsent = user.user_metadata?.onboarding_completed === undefined ||
                       user.user_metadata?.onboarding_completed === null;
    if (!flagAbsent) {
      // Flag is explicitly false — definitely redirect.
      redirect("/onboarding");
    }
    // Flag is absent — check track count as fallback.
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      try {
        const res = await fetch(`${apiUrl}/api/catalog/stats`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        if (res.ok) {
          const stats = await res.json();
          if (stats.total === 0) redirect("/onboarding");
        }
      } catch {
        // Network error — don't block the user, show the app.
      }
    }
  }

  return (
    <div className="flex h-screen bg-gray-950">
      <Sidebar userEmail={user.email ?? ""} />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
