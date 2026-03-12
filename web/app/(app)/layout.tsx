import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Sidebar from "@/components/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="flex h-screen bg-gray-950">
      <Sidebar userEmail={user.email ?? ""} />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
