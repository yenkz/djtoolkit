"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Bell, CheckCircle, XCircle, Download, AudioWaveform } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { apiClient } from "@/lib/api";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Notification {
  id: string;
  type: "batch_complete" | "track_failed" | "track_downloaded" | "analysis_complete";
  title: string;
  body: string;
  url: string | null;
  data: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
}

// ─── Relative time ──────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function NotificationBell() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const unreadCount = notifications.filter((n) => !n.read).length;

  // ── Fetch notifications ───────────────────────────────────────────────

  const loadNotifications = useCallback(async () => {
    try {
      const res = await apiClient("/notifications?limit=20");
      if (res.ok) {
        const data: Notification[] = await res.json();
        setNotifications(data);
      }
    } catch {
      // Silently fail — notifications are non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  // ── Realtime subscription ─────────────────────────────────────────────

  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;

    async function setup() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;

      channel = supabase
        .channel("notifications-bell")
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "push_notifications",
            filter: `user_id=eq.${session.user.id}`,
          },
          (payload) => {
            const row = payload.new as Notification;
            setNotifications((prev) => [row, ...prev].slice(0, 20));
          },
        )
        .subscribe();
    }
    setup();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  // ── Close on outside click ────────────────────────────────────────────

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClick);
    }
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // ── Close on Escape ───────────────────────────────────────────────────

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      document.addEventListener("keydown", handleKey);
    }
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  // ── Mark single as read + navigate ────────────────────────────────────

  async function handleClickNotification(n: Notification) {
    if (!n.read) {
      setNotifications((prev) =>
        prev.map((item) => (item.id === n.id ? { ...item, read: true } : item)),
      );
      apiClient("/notifications/read", {
        method: "PATCH",
        body: JSON.stringify({ id: n.id }),
      }).catch(() => {});
    }
    setOpen(false);
    if (n.url) router.push(n.url);
  }

  // ── Mark all as read ──────────────────────────────────────────────────

  async function handleMarkAllRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    apiClient("/notifications/read", {
      method: "PATCH",
      body: JSON.stringify({ all: true }),
    }).catch(() => {});
  }

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div ref={dropdownRef} className="relative">
      {/* Bell button */}
      <button
        onClick={() => setOpen(!open)}
        className="relative flex items-center justify-center rounded-lg transition-colors duration-200"
        style={{
          width: 36,
          height: 36,
          color: open ? "var(--led-blue)" : "var(--hw-text-dim)",
          background: open
            ? "rgba(68, 136, 255, 0.08)"
            : "transparent",
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.color = "var(--hw-text)";
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.color = "var(--hw-text-dim)";
        }}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
      >
        <Bell size={18} strokeWidth={2} />
        {unreadCount > 0 && (
          <span
            className="absolute flex items-center justify-center font-mono"
            aria-hidden="true"
            style={{
              top: 2,
              right: 2,
              minWidth: 16,
              height: 16,
              borderRadius: 8,
              fontSize: 9,
              fontWeight: 700,
              lineHeight: 1,
              padding: "0 4px",
              background: "var(--led-red, #ef4444)",
              color: "#fff",
              boxShadow: "0 0 8px color-mix(in srgb, var(--led-red, #ef4444) 50%, transparent)",
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          className="absolute right-0 z-50 rounded-lg border overflow-hidden"
          style={{
            top: "calc(100% + 8px)",
            width: 360,
            maxHeight: 440,
            background: "var(--hw-surface)",
            border: "1.5px solid var(--hw-card-border)",
            boxShadow:
              "0 8px 32px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.2)",
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between border-b"
            style={{
              padding: "12px 16px",
              borderColor: "var(--hw-border)",
            }}
          >
            <span
              className="font-mono uppercase"
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 1.5,
                color: "var(--hw-text-dim)",
              }}
            >
              Notifications
            </span>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="font-mono transition-colors duration-150"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "var(--led-blue)",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = "0.7";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = "1";
                }}
              >
                Mark all as read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div
            className="overflow-y-auto"
            style={{ maxHeight: 340 }}
          >
            {loading ? (
              <div
                className="flex items-center justify-center"
                style={{ padding: "32px 16px" }}
              >
                <span
                  className="font-mono text-xs uppercase tracking-widest"
                  style={{ color: "var(--hw-text-dim)" }}
                >
                  Loading...
                </span>
              </div>
            ) : notifications.length === 0 ? (
              <div
                className="flex items-center justify-center"
                style={{ padding: "32px 16px" }}
              >
                <span
                  className="font-sans text-sm"
                  style={{ color: "var(--hw-text-dim)" }}
                >
                  No notifications yet
                </span>
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => handleClickNotification(n)}
                  className="flex items-start w-full text-left transition-colors duration-150"
                  style={{
                    padding: "12px 16px",
                    gap: 12,
                    borderBottom: "1px solid var(--hw-border)",
                    background: "transparent",
                    cursor: "pointer",
                    border: "none",
                    borderBlockEnd: "1px solid var(--hw-border)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--hw-raised)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  {/* Unread dot */}
                  <div
                    className="flex-shrink-0"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      marginTop: 6,
                      background: n.read
                        ? "transparent"
                        : "var(--led-blue)",
                      boxShadow: n.read
                        ? "none"
                        : "0 0 6px color-mix(in srgb, var(--led-blue) 50%, transparent)",
                    }}
                  />

                  {/* Type icon */}
                  <div className="flex-shrink-0" style={{ marginTop: 1 }}>
                    {n.type === "batch_complete" ? (
                      <CheckCircle
                        size={16}
                        strokeWidth={2}
                        style={{ color: "var(--led-green, #22c55e)" }}
                      />
                    ) : n.type === "analysis_complete" ? (
                      <AudioWaveform
                        size={16}
                        strokeWidth={2}
                        style={{ color: "var(--led-orange, #ffa033)" }}
                      />
                    ) : n.type === "track_downloaded" ? (
                      <Download
                        size={16}
                        strokeWidth={2}
                        style={{ color: "var(--led-blue, #4488ff)" }}
                      />
                    ) : (
                      <XCircle
                        size={16}
                        strokeWidth={2}
                        style={{ color: "var(--led-red, #ef4444)" }}
                      />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div
                      className="font-sans truncate"
                      style={{
                        fontSize: 13,
                        fontWeight: n.read ? 500 : 700,
                        color: "var(--hw-text)",
                        lineHeight: 1.3,
                      }}
                    >
                      {n.title}
                    </div>
                    <div
                      className="font-sans"
                      style={{
                        fontSize: 12,
                        color: "var(--hw-text-dim)",
                        lineHeight: 1.4,
                        marginTop: 2,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {n.body}
                    </div>
                    <div
                      className="font-mono"
                      style={{
                        fontSize: 10,
                        color: "var(--hw-text-muted)",
                        marginTop: 4,
                      }}
                    >
                      {timeAgo(n.created_at)}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>

          {/* View all link */}
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="flex items-center justify-center font-mono transition-colors duration-150 border-t"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              padding: "10px 16px",
              color: "var(--led-blue)",
              borderColor: "var(--hw-border)",
              textDecoration: "none",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--hw-raised)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            View all notifications
          </Link>
        </div>
      )}
    </div>
  );
}
