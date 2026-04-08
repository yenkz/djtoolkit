"use client";

import { useState, useCallback } from "react";
import { GripVertical, Heart, HeartOff, Play, Pause, AlertTriangle } from "lucide-react";
import { usePreviewPlayer } from "@/lib/preview-player-context";
import EnergyBar from "@/components/ui/EnergyBar";
import type { Track } from "@/lib/api";

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
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
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
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ color: "var(--hw-text)", fontFamily: "var(--font-sans)", fontSize: 18, margin: 0 }}>
          Your Seeds
        </h2>
        {unanalyzedCount > 0 && (
          <div style={{
            display: "flex", alignItems: "center", gap: 4, fontSize: 12,
            color: "var(--led-orange)", background: "rgba(255,224,126,0.1)",
            padding: "4px 10px", borderRadius: 6,
          }}>
            <AlertTriangle size={14} /> {unanalyzedCount} tracks not analyzed
          </div>
        )}
      </div>

      {/* Column header */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "24px 24px 44px 1fr 56px 56px 56px 48px 56px 36px 36px",
        gap: 8, alignItems: "center", padding: "4px 12px",
        fontSize: 10, color: "var(--hw-text-dim)", textTransform: "uppercase", letterSpacing: 0.5,
        borderBottom: "1px solid var(--hw-border)", marginBottom: 4,
      }}>
        <span />
        <span style={{ textAlign: "center" }}>#</span>
        <span />
        <span>Track</span>
        <span style={{ textAlign: "right" }}>BPM</span>
        <span>Key</span>
        <span>Energy</span>
        <span>Dance</span>
        <span>Genre</span>
        <span />
        <span />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((item, idx) => {
          const isHovered = hoverIdx === idx;
          return (
            <div
              key={item.id}
              draggable
              onDragStart={() => handleDragStart(idx)}
              onDragOver={e => e.preventDefault()}
              onDrop={() => handleDrop(idx)}
              onMouseEnter={() => setHoverIdx(idx)}
              onMouseLeave={() => setHoverIdx(null)}
              style={{
                display: "grid",
                gridTemplateColumns: "24px 24px 44px 1fr 56px 56px 56px 48px 56px 36px 36px",
                gap: 8, alignItems: "center", padding: "6px 12px",
                background: isHovered
                  ? "rgba(126,255,126,0.08)"
                  : item.liked ? "rgba(126,255,126,0.03)" : "var(--hw-surface)",
                border: item.liked ? "1px solid rgba(126,255,126,0.15)" : "1px solid var(--hw-border)",
                borderRadius: 6, opacity: item.liked ? 1 : 0.5,
                cursor: "default",
                transition: "background 0.15s ease",
              }}
            >
              <GripVertical size={14} style={{ color: "var(--hw-text-dim)", cursor: "grab" }} />
              <span style={{ color: "var(--hw-text-dim)", fontSize: 11, textAlign: "center", fontFamily: "var(--font-mono)" }}>{idx + 1}</span>

              {/* Artwork */}
              {item.artwork_url ? (
                <img src={item.artwork_url} alt="" style={{ width: 38, height: 38, borderRadius: 4, objectFit: "cover" }} />
              ) : (
                <div style={{ width: 38, height: 38, borderRadius: 4, background: "var(--hw-raised)" }} />
              )}

              {/* Title + Artist */}
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "var(--hw-text)", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {item.title}
                </div>
                <div style={{ color: "var(--hw-text-dim)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {item.artist}
                </div>
              </div>

              {/* BPM */}
              <span style={{ color: "var(--hw-text-dim)", fontSize: 12, fontFamily: "var(--font-mono)", textAlign: "right" }}>
                {item.tempo ? Math.round(item.tempo) : "\u2014"}
              </span>

              {/* Key */}
              <span style={{ color: "var(--hw-text-dim)", fontSize: 12, fontFamily: "var(--font-mono)" }}>
                {item.key_normalized || "\u2014"}
              </span>

              {/* Energy bar */}
              <EnergyBar level={item.energy ?? 0} />

              {/* Danceability */}
              <span style={{ color: "var(--hw-text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                {item.danceability != null ? item.danceability.toFixed(2) : "\u2014"}
              </span>

              {/* Genre */}
              <span style={{ color: "var(--hw-text-dim)", fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {item.genres?.split(",")[0] || "\u2014"}
              </span>

              {/* Play */}
              <button onClick={() => togglePlay(item)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", justifyContent: "center" }}>
                {currentTrackId === item.id && isPlaying
                  ? <Pause size={18} color="var(--led-green)" />
                  : <Play size={18} color="var(--hw-text)" />
                }
              </button>

              {/* Like / Dislike */}
              <button onClick={() => toggleLike(item.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", justifyContent: "center" }}>
                {item.liked
                  ? <Heart size={22} color="var(--led-green)" fill="var(--led-green)" />
                  : <HeartOff size={22} color="var(--hw-text-dim)" />
                }
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
        <button onClick={onRegenerate} style={{
          padding: "8px 16px", borderRadius: 8, cursor: "pointer",
          background: "var(--hw-raised)", color: "var(--hw-text-dim)", border: "none", fontSize: 13,
        }}>
          Regenerate
        </button>
        <button onClick={handleExpand} disabled={loading} style={{
          padding: "8px 16px", borderRadius: 8, cursor: loading ? "wait" : "pointer",
          background: "var(--led-blue)", color: "#fff", border: "none", fontSize: 13, fontWeight: 600,
          opacity: loading ? 0.6 : 1,
        }}>
          {loading ? "Expanding..." : "Expand to 100 \u2192"}
        </button>
      </div>
    </div>
  );
}
