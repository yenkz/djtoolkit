"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCircle, XCircle, Download, AudioWaveform } from "lucide-react";
import { useNotifications, type Notification } from "@/lib/hooks/use-notifications";

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

function TypeIcon({ type }: { type: Notification["type"] }) {
  if (type === "batch_complete") return <CheckCircle size={14} strokeWidth={2} style={{ color: "var(--led-green, #22c55e)" }} />;
  if (type === "analysis_complete") return <AudioWaveform size={14} strokeWidth={2} style={{ color: "var(--led-orange, #ffa033)" }} />;
  if (type === "track_downloaded") return <Download size={14} strokeWidth={2} style={{ color: "var(--led-blue, #4488ff)" }} />;
  return <XCircle size={14} strokeWidth={2} style={{ color: "var(--led-red, #ef4444)" }} />;
}

export default function SidebarNotificationBell() {
  const router = useRouter();
  const { notifications, loading, unreadCount, markOneRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function handleClick(n: Notification) {
    if (!n.read) markOneRead(n.id);
    setOpen(false);
    if (n.url) router.push(n.url);
  }

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        style={{
          width: 28,
          height: 28,
          borderRadius: 4,
          border: "none",
          cursor: "pointer",
          color: open ? "var(--led-blue)" : "var(--hw-text-dim)",
          background: open ? "rgba(68,136,255,0.12)" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.color = "var(--hw-text)"; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.color = "var(--hw-text-dim)"; }}
      >
        <Bell size={14} strokeWidth={2} />
        {unreadCount > 0 && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--led-blue)",
              border: "1.5px solid var(--hw-surface)",
              boxShadow: "0 0 6px rgba(68,136,255,0.6)",
            }}
          />
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            left: "100%",
            bottom: 0,
            marginLeft: 8,
            zIndex: 200,
            width: 300,
            background: "var(--hw-panel)",
            border: "1px solid var(--hw-border-light)",
            borderRadius: 8,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid var(--hw-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span
              className="font-mono uppercase"
              style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "var(--hw-text-dim)" }}
            >
              Notifications
            </span>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="font-mono"
                style={{
                  background: "none",
                  border: "none",
                  fontSize: 9,
                  fontWeight: 700,
                  color: "var(--led-blue)",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div style={{ maxHeight: 340, overflowY: "auto" }}>
            {loading ? (
              <div style={{ padding: "24px 14px", textAlign: "center" }}>
                <span className="font-mono uppercase" style={{ fontSize: 10, color: "var(--hw-text-dim)", letterSpacing: 1.5 }}>
                  Loading…
                </span>
              </div>
            ) : notifications.length === 0 ? (
              <div style={{ padding: "24px 14px", textAlign: "center" }}>
                <span className="font-sans" style={{ fontSize: 12, color: "var(--hw-text-dim)" }}>
                  No notifications yet
                </span>
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => handleClick(n)}
                  className="w-full text-left"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    padding: "10px 14px",
                    gap: 10,
                    borderBottom: "1px solid var(--hw-border)",
                    background: n.read ? "transparent" : "rgba(68,136,255,0.04)",
                    opacity: n.read ? 0.6 : 1,
                    border: "none",
                    borderBlockEnd: "1px solid var(--hw-border)",
                    cursor: "pointer",
                    width: "100%",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--hw-raised)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = n.read ? "transparent" : "rgba(68,136,255,0.04)"; }}
                >
                  <div
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: n.read ? "transparent" : "var(--led-blue)",
                      boxShadow: n.read ? "none" : "0 0 6px rgba(68,136,255,0.4)",
                      flexShrink: 0,
                      marginTop: 5,
                    }}
                  />
                  <div style={{ flexShrink: 0, marginTop: 2 }}>
                    <TypeIcon type={n.type} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="font-sans truncate"
                      style={{ fontSize: 12, fontWeight: n.read ? 400 : 600, color: "var(--hw-text)", lineHeight: 1.3 }}
                    >
                      {n.title}
                    </div>
                    <div
                      className="font-mono"
                      style={{ fontSize: 9, color: "var(--hw-text-muted)", marginTop: 2, letterSpacing: 0.5 }}
                    >
                      {timeAgo(n.created_at)}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
