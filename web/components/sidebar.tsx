"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Download, LayoutGrid, SlidersHorizontal, Bot, Settings, LogOut, Menu, X } from "lucide-react";
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
  const [open, setOpen] = useState(false);

  // Close on route change
  useEffect(() => { setOpen(false); }, [pathname]);

  // Close on escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const sidebarContent = (
    <aside className="flex w-56 flex-col border-r border-hw-border bg-hw-surface h-full">
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

  return (
    <>
      {/* Mobile hamburger */}
      <button
        onClick={() => setOpen(true)}
        className="fixed left-3 top-3 z-50 flex h-9 w-9 items-center justify-center rounded-lg border border-hw-border bg-hw-surface md:hidden"
        aria-label="Open menu"
      >
        <Menu size={18} className="text-hw-text" />
      </button>

      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <div
        className={`fixed inset-y-0 left-0 z-50 transition-transform duration-200 md:hidden ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <button
          onClick={() => setOpen(false)}
          className="absolute right-2 top-3 flex h-8 w-8 items-center justify-center rounded text-hw-text-dim hover:text-hw-text"
          aria-label="Close menu"
        >
          <X size={16} />
        </button>
        {sidebarContent}
      </div>

      {/* Desktop sidebar */}
      <div className="hidden md:flex">
        {sidebarContent}
      </div>
    </>
  );
}
