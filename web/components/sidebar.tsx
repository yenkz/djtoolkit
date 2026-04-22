"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Download, Upload, LayoutGrid, SlidersHorizontal, Bot, Sparkles, ListMusic, Settings, LogOut, Menu, X, Sun, Moon, Monitor, ChevronsLeft, Home } from "lucide-react";
import { useTheme } from "@/lib/theme-provider";
import Logo from "@/components/ui/Logo";
import SidebarNotificationBell from "@/components/sidebar-notification-bell";
import type { LucideIcon } from "lucide-react";

const LIBRARY_NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/dashboard", label: "Home",      icon: Home },
  { href: "/import",    label: "Import",    icon: Download },
  { href: "/catalog",   label: "Catalog",   icon: LayoutGrid },
  { href: "/playlists", label: "Playlists", icon: ListMusic },
  { href: "/export",    label: "Export",    icon: Upload },
  { href: "/recommend", label: "Recommend", icon: Sparkles },
];

const OPS_NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/pipeline", label: "Pipeline", icon: SlidersHorizontal },
  { href: "/agents",   label: "Agents",   icon: Bot },
];

const THEME_OPTIONS = [
  { value: "light" as const, icon: Sun, label: "Light" },
  { value: "system" as const, icon: Monitor, label: "System" },
  { value: "dark" as const, icon: Moon, label: "Dark" },
];

function SidebarLogo({ collapsed }: { collapsed: boolean }) {
  const [hovered, setHovered] = useState(false);

  return (
    <Link
      href="/dashboard"
      className="flex items-center no-underline"
      style={{
        textDecoration: "none",
        padding: collapsed ? "16px 0" : "16px 20px",
        gap: collapsed ? 0 : 12,
        justifyContent: collapsed ? "center" : "flex-start",
        borderBottom: "1px solid var(--hw-border)",
        minHeight: 56,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        style={{
          transition: "filter 0.2s ease",
          filter: hovered
            ? "drop-shadow(0 0 6px var(--led-blue)) drop-shadow(0 0 12px color-mix(in srgb, var(--led-blue) 40%, transparent))"
            : "none",
        }}
      >
        <Logo
          w={collapsed ? 26 : 32}
          h={collapsed ? 18 : 22}
          color={hovered ? "var(--led-blue)" : "var(--sidebar-logo-color)"}
        />
      </span>
      {!collapsed && (
        <span
          className="font-mono text-xs font-bold uppercase tracking-widest"
          style={{
            transition: "color 0.2s ease, text-shadow 0.2s ease",
            color: hovered ? "var(--led-blue)" : "var(--hw-text-dim)",
            textShadow: hovered
              ? "0 0 12px color-mix(in srgb, var(--led-blue) 50%, transparent)"
              : "none",
            whiteSpace: "nowrap",
          }}
        >
          djtoolkit
        </span>
      )}
    </Link>
  );
}

function NavLink({
  item,
  pathname,
  collapsed,
  muted,
}: {
  item: { href: string; label: string; icon: LucideIcon };
  pathname: string;
  collapsed: boolean;
  muted: boolean;
}) {
  const active = pathname.startsWith(item.href);
  const Icon = item.icon;
  const defaultColor = muted ? "var(--hw-text-muted)" : "var(--hw-text-dim)";
  return (
    <Link
      href={item.href}
      className="flex items-center text-sm transition-all duration-200"
      title={collapsed ? item.label : undefined}
      style={{
        gap: collapsed ? 0 : 12,
        padding: collapsed ? "10px 0" : "10px 14px",
        justifyContent: collapsed ? "center" : "flex-start",
        color: active ? "var(--led-blue)" : defaultColor,
        background: active ? "rgba(68, 136, 255, 0.08)" : "transparent",
        borderLeft: active ? "2px solid var(--led-blue)" : "2px solid transparent",
        textShadow: active ? "0 0 14px rgba(68, 136, 255, 0.4)" : "none",
        borderRadius: collapsed ? 6 : 0,
        fontWeight: active && !muted ? 600 : 400,
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.color = "var(--hw-text)";
          e.currentTarget.style.background = "var(--hw-raised)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.color = defaultColor;
          e.currentTarget.style.background = "transparent";
        }
      }}
    >
      <Icon size={16} strokeWidth={2} style={{ flexShrink: 0 }} />
      {!collapsed && item.label}
    </Link>
  );
}

export default function Sidebar({ userEmail }: { userEmail: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { theme, setTheme } = useTheme();

  // Close on route change
  // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing mobile drawer with route changes
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
    // aside must stay position:static — SidebarNotificationBell drawer (position:absolute left:100%) escapes overflow:hidden only because this element has no position set
    <aside
      className="flex flex-col border-r border-hw-border bg-hw-surface h-full"
      style={{
        width: collapsed ? 56 : 224,
        transition: "width 0.2s ease",
        overflow: "hidden",
      }}
    >
      <SidebarLogo collapsed={collapsed} />

      <nav className="flex-1 py-2" style={{ padding: collapsed ? "8px 4px" : "8px 12px" }}>
        {/* Library group */}
        {!collapsed && (
          <div
            className="font-mono uppercase"
            style={{
              padding: "8px 14px 4px",
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: 2,
              color: "var(--hw-border-light)",
            }}
          >
            Library
          </div>
        )}
        {LIBRARY_NAV.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} collapsed={collapsed} muted={false} />
        ))}

        {/* Divider */}
        <div style={{ height: 1, background: "var(--hw-border)", margin: collapsed ? "6px 8px" : "8px 14px" }} />

        {/* Operations group */}
        {!collapsed && (
          <div
            className="font-mono uppercase"
            style={{
              padding: "4px 14px 4px",
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: 2,
              color: "var(--hw-border-light)",
            }}
          >
            Operations
          </div>
        )}
        {OPS_NAV.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} collapsed={collapsed} muted={true} />
        ))}
      </nav>

      <div
        className="border-t border-hw-border"
        style={{ padding: collapsed ? "10px 4px" : "10px 14px", position: "relative" }}
      >
        {!collapsed && (
          <p
            className="font-mono truncate"
            style={{ fontSize: 9, color: "var(--hw-text-muted)", marginBottom: 6, letterSpacing: 0.3 }}
          >
            {userEmail}
          </p>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: collapsed ? 0 : 4,
            flexDirection: collapsed ? "column" : "row",
            justifyContent: collapsed ? "center" : "flex-start",
          }}
        >
          {/* Theme toggles — only when expanded */}
          {!collapsed &&
            THEME_OPTIONS.map(({ value, icon: Icon, label }) => {
              const active = theme === value;
              return (
                <button
                  key={value}
                  onClick={() => setTheme(value)}
                  aria-label={`${label} theme`}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 4,
                    border: "none",
                    cursor: "pointer",
                    background: active ? "rgba(68, 136, 255, 0.12)" : "transparent",
                    color: active ? "var(--led-blue)" : "var(--hw-text-dim)",
                    boxShadow: active ? "0 0 8px rgba(68, 136, 255, 0.25)" : "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon size={13} strokeWidth={2} />
                </button>
              );
            })}

          <div style={{ flex: collapsed ? 0 : 1 }} />

          {/* Settings link */}
          <Link
            href="/settings"
            aria-label="Settings"
            title={collapsed ? "Settings" : undefined}
            style={{
              width: 28,
              height: 28,
              borderRadius: 4,
              color: pathname.startsWith("/settings") ? "var(--led-blue)" : "var(--hw-text-dim)",
              background: pathname.startsWith("/settings") ? "rgba(68,136,255,0.12)" : "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              textDecoration: "none",
            }}
            onMouseEnter={(e) => {
              if (!pathname.startsWith("/settings")) e.currentTarget.style.color = "var(--hw-text)";
            }}
            onMouseLeave={(e) => {
              if (!pathname.startsWith("/settings")) e.currentTarget.style.color = "var(--hw-text-dim)";
            }}
          >
            <Settings size={14} strokeWidth={2} />
          </Link>

          {/* Notification bell + drawer */}
          <SidebarNotificationBell />

          {/* Collapse toggle */}
          <button
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            style={{
              width: 28,
              height: 28,
              borderRadius: 4,
              border: "none",
              cursor: "pointer",
              background: "transparent",
              color: "var(--hw-text-dim)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--hw-text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--hw-text-dim)"; }}
          >
            <ChevronsLeft
              size={14}
              strokeWidth={2}
              style={{
                transform: collapsed ? "rotate(180deg)" : "none",
                transition: "transform 0.2s ease",
              }}
            />
          </button>
        </div>

        {/* Sign out */}
        <button
          onClick={signOut}
          className="flex items-center"
          title={collapsed ? "Sign out" : undefined}
          style={{
            marginTop: 8,
            width: "100%",
            gap: collapsed ? 0 : 6,
            justifyContent: collapsed ? "center" : "flex-start",
            background: "none",
            border: "none",
            color: "var(--hw-text-dim)",
            fontSize: 11,
            cursor: "pointer",
            padding: "4px 0",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--led-red)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--hw-text-dim)"; }}
        >
          <LogOut size={12} strokeWidth={2} style={{ flexShrink: 0 }} />
          {!collapsed && "Sign out"}
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
        aria-hidden={!open}
        {...(!open ? { inert: true } : {})}
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
