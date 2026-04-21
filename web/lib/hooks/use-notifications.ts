"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { apiClient } from "@/lib/api";

export interface Notification {
  id: string;
  type: "batch_complete" | "track_failed" | "track_downloaded" | "analysis_complete";
  title: string;
  body: string;
  url: string | null;
  data: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const load = useCallback(async () => {
    try {
      const res = await apiClient("/notifications?limit=20");
      if (res.ok) {
        const data: Notification[] = await res.json();
        setNotifications(data);
      }
    } catch {
      // silent — notifications are non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;

    async function setup() {
      const { data: { session } } = await supabase.auth.getSession();
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

  const markOneRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    apiClient("/notifications/read", {
      method: "PATCH",
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    apiClient("/notifications/read", {
      method: "PATCH",
      body: JSON.stringify({ all: true }),
    }).catch(() => {});
  }, []);

  return { notifications, loading, unreadCount, markOneRead, markAllRead };
}
