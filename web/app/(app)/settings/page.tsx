"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { disconnectSpotify } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

const API_URL = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api`;

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
      <h1 className="text-xl font-bold text-white">Settings</h1>

      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5 space-y-4">
        <h2 className="font-semibold text-white">Spotify</h2>
        <p className="text-sm text-gray-400">
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
            className="rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-600"
          >
            Connect Spotify
          </button>
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 disabled:opacity-50"
          >
            {disconnecting ? "Disconnecting..." : "Disconnect"}
          </button>
        </div>
      </section>
    </div>
  );
}
