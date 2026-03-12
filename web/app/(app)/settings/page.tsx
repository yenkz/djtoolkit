"use client";

import { useState } from "react";
import { toast } from "sonner";
import { disconnectSpotify } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export default function SettingsPage() {
  const [disconnecting, setDisconnecting] = useState(false);

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
          <a
            href={`${API_URL}/auth/spotify/connect`}
            className="rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-600"
          >
            Connect Spotify
          </a>
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
