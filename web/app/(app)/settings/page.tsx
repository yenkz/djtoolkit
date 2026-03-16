"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { disconnectSpotify } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

const API_URL = "/api";

export default function SettingsPage() {
  const [disconnecting, setDisconnecting] = useState(false);
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get("spotify") === "connected") {
      toast.success("Spotify connected successfully!");
      window.history.replaceState({}, "", "/settings");
    } else if (searchParams.get("spotify") === "error") {
      toast.error("Spotify connection failed. Please try again.");
      window.history.replaceState({}, "", "/settings");
    }
  }, [searchParams]);

  async function handleDisconnect() {
    if (!confirm("Disconnect Spotify? You won't be able to import playlists until you reconnect.")) return;
    setDisconnecting(true);
    try {
      await disconnectSpotify();
      toast.success("Spotify disconnected");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="space-y-6 max-w-xl">
      <h1 className="text-xl font-bold text-hw-text">Settings</h1>

      <section className="rounded-xl border border-hw-border bg-hw-surface p-5 space-y-4">
        <h2 className="font-semibold text-hw-text">Spotify</h2>
        <p className="text-sm text-hw-text-dim">
          Connect your Spotify account to import playlists directly.
        </p>
        <div className="flex gap-3">
          <button
            onClick={async () => {
              const supabase = createClient();
              const { data: { session } } = await supabase.auth.getSession();
              const token = session?.access_token ?? "";
              window.location.href = `${API_URL}/auth/spotify/connect?token=${encodeURIComponent(token)}&return_to=/settings`;
            }}
            className="rounded-lg bg-led-green px-4 py-2 text-sm font-medium text-hw-text hover:bg-led-green/80"
          >
            Connect Spotify
          </button>
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="rounded-lg border border-hw-border px-4 py-2 text-sm text-hw-text-dim hover:bg-hw-raised disabled:opacity-50"
          >
            {disconnecting ? "Disconnecting..." : "Disconnect"}
          </button>
        </div>
      </section>
    </div>
  );
}
