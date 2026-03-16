"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Download, LayoutGrid, SlidersHorizontal, Bot, Settings, LogOut } from "lucide-react";
import Logo from "@/components/ui/Logo";
import type { LucideIcon } from "lucide-react";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/import", label: "Import", icon: Download },
  { href: "/catalog", label: "Catalog", icon: LayoutGrid },
  { href: "/pipeline", label: "Pipeline", icon: SlidersHorizontal },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default function Sidebar({ userEmail }: { userEmail: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="flex w-56 flex-col border-r border-hw-border bg-hw-surface">
      <div className="flex items-center gap-3 px-5 py-4">
        <Logo w={32} h={22} />
        <span
          className="font-mono text-xs font-bold uppercase tracking-widest text-hw-text-dim"
        >
          djtoolkit
        </span>
      </div>

      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-3 px-3 py-2 text-sm font-medium transition-all duration-200"
              style={{
                color: active
                  ? "var(--led-blue)"
                  : "var(--hw-text-dim)",
                background: active
                  ? "rgba(68, 136, 255, 0.08)"
                  : "transparent",
                borderLeft: active
                  ? "2px solid var(--led-blue)"
                  : "2px solid transparent",
                textShadow: active
                  ? "0 0 14px rgba(68, 136, 255, 0.4)"
                  : "none",
              }}
              onMouseEnter={(e) => {
                if (!active) {
                  e.currentTarget.style.color = "var(--hw-text)";
                  e.currentTarget.style.background = "var(--hw-raised)";
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  e.currentTarget.style.color = "var(--hw-text-dim)";
                  e.currentTarget.style.background = "transparent";
                }
              }}
            >
              <Icon size={16} strokeWidth={2} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-hw-border px-4 py-3">
        <p className="truncate text-xs text-hw-text-dim">{userEmail}</p>
        <button
          onClick={signOut}
          className="mt-1 flex items-center gap-1.5 text-xs transition-colors duration-200"
          style={{ color: "var(--hw-text-dim)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--led-red)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--hw-text-dim)";
          }}
        >
          <LogOut size={12} strokeWidth={2} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
