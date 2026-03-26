"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, XCircle, Download, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { apiClient } from "@/lib/api";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Notification {
  id: string;
  type: "batch_complete" | "track_failed" | "track_downloaded";
  title: string;
  body: string;
  url: string | null;
  data: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
}

type FilterType = "" | "batch_complete" | "track_failed" | "track_downloaded";

const FILTER_OPTIONS: { value: FilterType; label: string }[] = [
  { value: "", label: "All" },
  { value: "track_downloaded", label: "Downloads" },
  { value: "track_failed", label: "Failures" },
  { value: "batch_complete", label: "Batch Complete" },
];

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

// ─── Type icon ──────────────────────────────────────────────────────────────

function NotificationIcon({ type }: { type: Notification["type"] }) {
  switch (type) {
    case "batch_complete":
      return (
        <CheckCircle
          size={18}
          strokeWidth={2}
          style={{ color: "var(--led-green, #22c55e)" }}
        />
      );
    case "track_failed":
      return (
        <XCircle
          size={18}
          strokeWidth={2}
          style={{ color: "var(--led-red, #ef4444)" }}
        />
      );
    case "track_downloaded":
      return (
        <Download
          size={18}
          strokeWidth={2}
          style={{ color: "var(--led-blue, #4488ff)" }}
        />
      );
    default:
      return (
        <CheckCircle
          size={18}
          strokeWidth={2}
          style={{ color: "var(--hw-text-dim)" }}
        />
      );
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function NotificationsPage() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [filter, setFilter] = useState<FilterType>("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const pageSize = 30;
  const offsetRef = useRef(0);

  const unreadCount = notifications.filter((n) => !n.read).length;

  // ── Fetch notifications ───────────────────────────────────────────────

  const loadNotifications = useCallback(
    async (reset = true) => {
      if (reset) {
        setLoading(true);
        offsetRef.current = 0;
      } else {
        setLoadingMore(true);
      }
      try {
        const qs = new URLSearchParams();
        qs.set("limit", String(pageSize));
        qs.set("offset", String(offsetRef.current));
        if (filter) qs.set("type", filter);
        const res = await apiClient(`/notifications?${qs}`);
        if (res.ok) {
          const data: Notification[] = await res.json();
          if (reset) {
            setNotifications(data);
          } else {
            setNotifications((prev) => [...prev, ...data]);
          }
          setHasMore(data.length === pageSize);
          offsetRef.current += data.length;
        }
      } catch {
        // Silently fail — notifications are non-critical
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [filter],
  );

  useEffect(() => {
    loadNotifications(true);
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
        .channel("notifications-page")
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
            // Only add if it matches the current filter
            if (!filter || row.type === filter) {
              setNotifications((prev) => [row, ...prev]);
            }
          },
        )
        .subscribe();
    }
    setup();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [filter]);

  // ── Mark single as read ────────────────────────────────────────────────

  async function handleClickNotification(n: Notification) {
    if (!n.read) {
      setNotifications((prev) =>
        prev.map((item) =>
          item.id === n.id ? { ...item, read: true } : item,
        ),
      );
      apiClient("/notifications/read", {
        method: "PATCH",
        body: JSON.stringify({ id: n.id }),
      }).catch(() => {});
    }
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

  // ── Delete single ─────────────────────────────────────────────────────

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    apiClient("/notifications", {
      method: "DELETE",
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }

  // ── Clear all ─────────────────────────────────────────────────────────

  async function handleClearAll() {
    setNotifications([]);
    setConfirmClear(false);
    apiClient("/notifications", {
      method: "DELETE",
      body: JSON.stringify({ all: true }),
    }).catch(() => {});
  }

  // ── Load more ─────────────────────────────────────────────────────────

  function handleLoadMore() {
    loadNotifications(false);
  }

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      {/* Page header */}
      <div
        className="flex items-center gap-3"
        style={{ marginBottom: 24 }}
      >
        <h1
          className="font-mono uppercase"
          style={{
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: 1.5,
            color: "var(--hw-text)",
            margin: 0,
          }}
        >
          Notifications
        </h1>
        {unreadCount > 0 && (
          <span
            className="flex items-center justify-center font-mono"
            style={{
              minWidth: 22,
              height: 22,
              borderRadius: 11,
              fontSize: 11,
              fontWeight: 700,
              lineHeight: 1,
              padding: "0 6px",
              background: "var(--led-blue, #4488ff)",
              color: "#fff",
              boxShadow:
                "0 0 8px color-mix(in srgb, var(--led-blue, #4488ff) 50%, transparent)",
            }}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </div>

      {/* Filter tabs + Action bar */}
      <div
        className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
        style={{ marginBottom: 16 }}
      >
        {/* Filter tabs */}
        <div className="flex items-center gap-1">
          {FILTER_OPTIONS.map((opt) => {
            const active = filter === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setFilter(opt.value)}
                className="font-mono transition-colors duration-200"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  padding: "6px 12px",
                  borderRadius: 4,
                  border: "none",
                  cursor: "pointer",
                  color: active
                    ? "var(--led-blue)"
                    : "var(--hw-text-dim)",
                  background: active
                    ? "rgba(68, 136, 255, 0.08)"
                    : "transparent",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button
              onClick={handleMarkAllRead}
              className="font-mono transition-colors duration-150"
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                padding: "6px 12px",
                borderRadius: 4,
                border: "1px solid var(--hw-border)",
                cursor: "pointer",
                color: "var(--led-blue)",
                background: "transparent",
              }}
            >
              Mark all as read
            </button>
          )}
          {notifications.length > 0 && (
            <>
              {confirmClear ? (
                <div className="flex items-center gap-2">
                  <span
                    className="font-mono"
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: "var(--led-red)",
                    }}
                  >
                    Delete all?
                  </span>
                  <button
                    onClick={handleClearAll}
                    className="font-mono transition-colors duration-150"
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 0.5,
                      textTransform: "uppercase",
                      padding: "6px 12px",
                      borderRadius: 4,
                      border: "1px solid var(--led-red)",
                      cursor: "pointer",
                      color: "#fff",
                      background: "var(--led-red)",
                    }}
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setConfirmClear(false)}
                    className="font-mono transition-colors duration-150"
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 0.5,
                      textTransform: "uppercase",
                      padding: "6px 12px",
                      borderRadius: 4,
                      border: "1px solid var(--hw-border)",
                      cursor: "pointer",
                      color: "var(--hw-text-dim)",
                      background: "transparent",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmClear(true)}
                  className="font-mono transition-colors duration-150"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.5,
                    textTransform: "uppercase",
                    padding: "6px 12px",
                    borderRadius: 4,
                    border: "1px solid var(--hw-border)",
                    cursor: "pointer",
                    color: "var(--led-red)",
                    background: "transparent",
                  }}
                >
                  Clear all
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Notification list */}
      <div
        className="rounded-lg border overflow-hidden"
        style={{
          background: "var(--hw-surface)",
          border: "1.5px solid var(--hw-card-border)",
        }}
      >
        {loading ? (
          <div
            className="flex items-center justify-center"
            style={{ padding: "48px 16px" }}
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
            className="flex flex-col items-center justify-center gap-2"
            style={{ padding: "48px 16px" }}
          >
            <span
              className="font-sans text-sm"
              style={{ color: "var(--hw-text-dim)" }}
            >
              No notifications
            </span>
            {filter && (
              <button
                onClick={() => setFilter("")}
                className="font-mono text-xs transition-colors duration-150"
                style={{
                  color: "var(--led-blue)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                Clear filter
              </button>
            )}
          </div>
        ) : (
          <>
            {notifications.map((n) => (
              <button
                key={n.id}
                onClick={() => handleClickNotification(n)}
                onMouseEnter={() => setHoveredId(n.id)}
                onMouseLeave={() => setHoveredId(null)}
                className="flex items-start w-full text-left transition-colors duration-150"
                style={{
                  padding: "14px 16px",
                  gap: 12,
                  background: "transparent",
                  cursor: "pointer",
                  border: "none",
                  borderBottom: "1px solid var(--hw-border)",
                }}
              >
                {/* Unread dot */}
                <div
                  className="flex-shrink-0"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    marginTop: 7,
                    background: n.read
                      ? "transparent"
                      : "var(--led-blue)",
                    boxShadow: n.read
                      ? "none"
                      : "0 0 6px color-mix(in srgb, var(--led-blue) 50%, transparent)",
                  }}
                />

                {/* Type icon */}
                <div className="flex-shrink-0" style={{ marginTop: 2 }}>
                  <NotificationIcon type={n.type} />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div
                    className="font-sans"
                    style={{
                      fontSize: 14,
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
                      fontSize: 13,
                      color: "var(--hw-text-dim)",
                      lineHeight: 1.5,
                      marginTop: 3,
                    }}
                  >
                    {n.body}
                  </div>
                  <div
                    className="font-mono"
                    style={{
                      fontSize: 10,
                      color: "var(--hw-text-muted)",
                      marginTop: 6,
                    }}
                  >
                    {timeAgo(n.created_at)}
                  </div>
                </div>

                {/* Delete button */}
                <div
                  className="flex-shrink-0 flex items-center"
                  style={{
                    marginTop: 2,
                    opacity: hoveredId === n.id ? 1 : 0,
                    transition: "opacity 0.15s ease",
                  }}
                >
                  <button
                    onClick={(e) => handleDelete(n.id, e)}
                    className="flex items-center justify-center rounded transition-colors duration-150"
                    style={{
                      width: 28,
                      height: 28,
                      color: "var(--hw-text-dim)",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "var(--led-red)";
                      e.currentTarget.style.background =
                        "rgba(239, 68, 68, 0.08)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "var(--hw-text-dim)";
                      e.currentTarget.style.background = "transparent";
                    }}
                    aria-label="Delete notification"
                  >
                    <Trash2 size={14} strokeWidth={2} />
                  </button>
                </div>
              </button>
            ))}

            {/* Load more */}
            {hasMore && (
              <div
                className="flex items-center justify-center"
                style={{ padding: "16px" }}
              >
                <button
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="font-mono transition-colors duration-150"
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: 0.5,
                    textTransform: "uppercase",
                    padding: "8px 20px",
                    borderRadius: 4,
                    border: "1px solid var(--hw-border)",
                    cursor: loadingMore ? "default" : "pointer",
                    color: loadingMore
                      ? "var(--hw-text-muted)"
                      : "var(--led-blue)",
                    background: "transparent",
                  }}
                >
                  {loadingMore ? "Loading..." : "Load more"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
