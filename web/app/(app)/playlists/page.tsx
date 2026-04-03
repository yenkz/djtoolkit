"use client";

import { useState, useEffect, useCallback } from "react";
import { ListMusic } from "lucide-react";
import Link from "next/link";
import PlaylistCard from "@/components/playlists/PlaylistCard";
import PlaylistDetailView from "@/components/playlists/PlaylistDetail";
import { fetchPlaylists, deletePlaylist, type Playlist } from "@/lib/api";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";
import { toast } from "sonner";

export default function PlaylistsPage() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchPlaylists();
      setPlaylists(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load playlists");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deletePlaylist(id);
      setPlaylists((prev) => prev.filter((p) => p.id !== id));
      if (expandedId === id) setExpandedId(null);
      toast.success("Playlist deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }, [expandedId]);

  return (
    <div className="flex-1 overflow-auto p-6">
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <h1 style={{ color: HARDWARE.text, fontFamily: FONTS.sans, fontSize: 22, fontWeight: 700, marginBottom: 20 }}>
          Playlists
        </h1>

        {loading ? (
          <p style={{ color: HARDWARE.textDim, fontSize: 13 }}>Loading...</p>
        ) : playlists.length === 0 ? (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
            padding: "60px 20px", color: HARDWARE.textDim, textAlign: "center",
          }}>
            <ListMusic size={40} strokeWidth={1.5} />
            <p style={{ fontSize: 14 }}>No playlists yet</p>
            <p style={{ fontSize: 12 }}>
              Create your first playlist by exporting from the{" "}
              <Link href="/recommend" style={{ color: LED_COLORS.blue.on, textDecoration: "underline" }}>
                Recommend
              </Link>{" "}
              page.
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {playlists.map((pl) => (
              <PlaylistCard
                key={pl.id}
                playlist={pl}
                expanded={expandedId === pl.id}
                onToggle={() => setExpandedId(expandedId === pl.id ? null : pl.id)}
                onDelete={() => handleDelete(pl.id)}
              >
                {expandedId === pl.id && (
                  <PlaylistDetailView
                    playlistId={pl.id}
                    sessionId={pl.session_id}
                    playlistName={pl.name}
                  />
                )}
              </PlaylistCard>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
