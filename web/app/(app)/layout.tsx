import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Sidebar from "@/components/sidebar";
import { PreviewPlayerProvider } from "@/lib/preview-player-context";
import NotificationBell from "@/components/notification-bell";
import NotificationProvider from "@/components/notification-provider";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="flex h-screen bg-hw-body">
      <Sidebar userEmail={user.email ?? ""} />
      <main className="relative flex-1 overflow-y-auto p-6 pt-14 md:pt-6">
        {/* Notification bell — top-right corner of main content */}
        <div
          className="fixed right-4 top-3 z-40 md:absolute md:right-6 md:top-4"
        >
          <NotificationBell />
        </div>
        <NotificationProvider />
        <PreviewPlayerProvider>{children}</PreviewPlayerProvider>
      </main>
    </div>
  );
}
