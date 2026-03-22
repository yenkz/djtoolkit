import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Sidebar from "@/components/sidebar";
import { PreviewPlayerProvider } from "@/lib/preview-player-context";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="flex h-screen bg-hw-body">
      <Sidebar userEmail={user.email ?? ""} />
      <main className="flex-1 overflow-y-auto p-6 pt-14 md:pt-6">
        <PreviewPlayerProvider>{children}</PreviewPlayerProvider>
      </main>
    </div>
  );
}
