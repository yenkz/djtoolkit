"use client";

import { useState, useCallback } from "react";
import { GripVertical, Heart, Play, Pause, AlertTriangle } from "lucide-react";
import { usePreviewPlayer } from "@/lib/preview-player-context";
import type { Track } from "@/lib/api";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";

interface SeedListProps {
  seeds: Track[];
  unanalyzedCount: number;
  onExpand: (feedback: { track_id: number; liked: boolean; position: number }[]) => void;
  onRegenerate: () => void;
  loading: boolean;
}

interface SeedItem extends Track {
  liked: boolean;
  position: number;
}

export default function SeedList({ seeds, unanalyzedCount, onExpand, onRegenerate, loading }: SeedListProps) {
  const [items, setItems] = useState<SeedItem[]>(() => seeds.map((s, i) => ({ ...s, liked: true, position: i })));
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const { currentTrackId, isPlaying, play, playUrl, pause } = usePreviewPlayer();

  const toggleLike = useCallback((id: number) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, liked: !item.liked } : item));
  }, []);

  const handleDragStart = (idx: number) => setDragIdx(idx);

  const handleDrop = (dropIdx: number) => {
    if (dragIdx === null || dragIdx === dropIdx) return;
    setItems(prev => {
      const next = [...prev];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(dropIdx, 0, moved);
      return next;
    });
    setDragIdx(null);
  };

  const handleExpand = () => {
    const feedback = items.map((item, i) => ({
      track_id: item.id,
      liked: item.liked,
      position: i + 1,
    }));
    onExpand(feedback);
  };

  const togglePlay = (track: SeedItem) => {
    if (currentTrackId === track.id && isPlaying) {
      pause();
    } else if (track.spotify_uri) {
      play(track.id, track.spotify_uri);
    } else if (track.preview_url) {
      playUrl(track.id, track.preview_url, { title: track.title, artist: track.artist });
    }
  };

  return (
    <div style={{ maxWidth: 600, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ color: HARDWARE.text, fontFamily: FONTS.sans, fontSize: 18, margin: 0 }}>
          Your Seeds
        </h2>
        {unanalyzedCount > 0 && (
          <div style={{
            display: "flex", alignItems: "center", gap: 4, fontSize: 12,
            color: LED_COLORS.orange.on, background: "rgba(255,224,126,0.1)",
            padding: "4px 10px", borderRadius: 6,
          }}>
            <AlertTriangle size={14} /> {unanalyzedCount} tracks not analyzed
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((item, idx) => (
          <div
            key={item.id}
            draggable
            onDragStart={() => handleDragStart(idx)}
            onDragOver={e => e.preventDefault()}
            onDrop={() => handleDrop(idx)}
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
              background: item.liked ? "rgba(126,255,126,0.05)" : HARDWARE.surface,
              border: `1px solid ${item.liked ? "rgba(126,255,126,0.2)" : HARDWARE.border}`,
              borderRadius: 8, opacity: item.liked ? 1 : 0.5,
            }}
          >
            <GripVertical size={16} style={{ color: HARDWARE.textDim, cursor: "grab" }} />
            <span style={{ color: HARDWARE.textDim, fontSize: 12, width: 20, textAlign: "center" }}>{idx + 1}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: HARDWARE.text, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {item.artist} &mdash; {item.title}
              </div>
              <div style={{ color: HARDWARE.textDim, fontSize: 11 }}>
                {item.tempo ? Math.round(item.tempo) : "?"} BPM &middot; {item.key_normalized || "?"} &middot; E {item.energy?.toFixed(2) || "?"}
              </div>
            </div>
            <button onClick={() => togglePlay(item)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
              {currentTrackId === item.id && isPlaying
                ? <Pause size={16} color={LED_COLORS.green.on} />
                : <Play size={16} color={HARDWARE.text} />
              }
            </button>
            <button onClick={() => toggleLike(item.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
              <Heart size={18} color={item.liked ? LED_COLORS.green.on : HARDWARE.textDim} fill={item.liked ? LED_COLORS.green.on : "none"} />
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
        <button onClick={onRegenerate} style={{
          padding: "8px 16px", borderRadius: 8, cursor: "pointer",
          background: HARDWARE.raised, color: HARDWARE.textDim, border: "none", fontSize: 13,
        }}>
          Regenerate
        </button>
        <button onClick={handleExpand} disabled={loading} style={{
          padding: "8px 16px", borderRadius: 8, cursor: loading ? "wait" : "pointer",
          background: LED_COLORS.blue.on, color: "#fff", border: "none", fontSize: 13, fontWeight: 600,
          opacity: loading ? 0.6 : 1,
        }}>
          {loading ? "Expanding..." : "Expand to 100 \u2192"}
        </button>
      </div>
    </div>
  );
}
