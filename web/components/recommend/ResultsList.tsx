"use client";

import { useState } from "react";
import { Heart, HeartOff, Play, Pause, RefreshCw, Download } from "lucide-react";
import { usePreviewPlayer } from "@/lib/preview-player-context";
import EnergyBar from "@/components/ui/EnergyBar";
import type { Track } from "@/lib/api";
import EnergyArc from "./EnergyArc";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";

interface ResultsListProps {
  tracks: Track[];
  onRefine: (feedback: { track_id: number; liked: boolean }[]) => void;
  onExport: () => void;
  refining: boolean;
}

export default function ResultsList({ tracks, onRefine, onExport, refining }: ResultsListProps) {
  const [feedback, setFeedback] = useState<Record<number, boolean>>({});
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const { currentTrackId, isPlaying, play, playUrl, pause } = usePreviewPlayer();

  const toggleFeedback = (id: number, liked: boolean) => {
    setFeedback(prev => {
      if (prev[id] === liked) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: liked };
    });
  };

  const handleRefine = () => {
    const fb = Object.entries(feedback).map(([id, liked]) => ({ track_id: Number(id), liked }));
    if (fb.length === 0) return;
    onRefine(fb);
  };

  const togglePlay = (track: Track) => {
    if (currentTrackId === track.id && isPlaying) {
      pause();
    } else if (track.spotify_uri) {
      play(track.id, track.spotify_uri);
    } else if (track.preview_url) {
      playUrl(track.id, track.preview_url, { title: track.title, artist: track.artist });
    }
  };

  const totalMs = tracks.reduce((sum, t) => sum + (t.duration_ms ?? 0), 0);
  const totalMin = Math.floor(totalMs / 60000);
  const totalHrs = Math.floor(totalMin / 60);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ color: HARDWARE.text, fontSize: 14, fontWeight: 600 }}>
          {tracks.length} tracks &middot; {totalHrs}h {totalMin % 60}m
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          {Object.keys(feedback).length > 0 && (
            <button onClick={handleRefine} disabled={refining} style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "4px 12px", borderRadius: 6, cursor: refining ? "wait" : "pointer",
              background: LED_COLORS.blue.mid, color: "#fff", border: "none", fontSize: 12,
            }}>
              <RefreshCw size={12} /> {refining ? "Refining..." : "Re-run with feedback"}
            </button>
          )}
          <button onClick={onExport} style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "4px 12px", borderRadius: 6, cursor: "pointer",
            background: LED_COLORS.green.mid, color: "#fff", border: "none", fontSize: 12,
          }}>
            <Download size={12} /> Export Playlist
          </button>
        </div>
      </div>

      <EnergyArc tracks={tracks} />

      {/* Column header */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "28px 36px 1fr 50px 50px 48px 42px 50px 30px 30px 30px",
        gap: 6, alignItems: "center", padding: "4px 8px", marginTop: 8,
        fontSize: 9, color: HARDWARE.textDim, textTransform: "uppercase", letterSpacing: 0.5,
        borderBottom: `1px solid ${HARDWARE.border}`, marginBottom: 2,
      }}>
        <span style={{ textAlign: "right" }}>#</span>
        <span />
        <span>Track</span>
        <span style={{ textAlign: "right" }}>BPM</span>
        <span>Key</span>
        <span>Energy</span>
        <span>Dance</span>
        <span>Genre</span>
        <span />
        <span />
        <span />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {tracks.map((t, i) => {
          const isHovered = hoverIdx === i;
          const isLiked = feedback[t.id] === true;
          const isDisliked = feedback[t.id] === false;
          return (
            <div
              key={t.id}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              style={{
                display: "grid",
                gridTemplateColumns: "28px 36px 1fr 50px 50px 48px 42px 50px 30px 30px 30px",
                gap: 6, alignItems: "center", padding: "4px 8px",
                background: isHovered ? "rgba(68,136,255,0.08)" : HARDWARE.groove,
                borderRadius: 4, fontSize: 12,
                transition: "background 0.12s ease",
                cursor: "default",
              }}
            >
              <span style={{ color: HARDWARE.textDim, textAlign: "right", fontFamily: FONTS.mono, fontSize: 11 }}>{i + 1}</span>

              {/* Artwork */}
              {t.artwork_url ? (
                <img src={t.artwork_url} alt="" style={{ width: 32, height: 32, borderRadius: 3, objectFit: "cover" }} />
              ) : (
                <div style={{ width: 32, height: 32, borderRadius: 3, background: HARDWARE.raised }} />
              )}

              {/* Title + Artist */}
              <div style={{ minWidth: 0 }}>
                <div style={{ color: HARDWARE.text, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.title}
                </div>
                <div style={{ color: HARDWARE.textDim, fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.artist}
                </div>
              </div>

              {/* BPM */}
              <span style={{ color: HARDWARE.textDim, fontFamily: FONTS.mono, fontSize: 11, textAlign: "right" }}>
                {Math.round(t.tempo ?? 0)}
              </span>

              {/* Key */}
              <span style={{ color: HARDWARE.textDim, fontFamily: FONTS.mono, fontSize: 11 }}>
                {t.key_normalized || ""}
              </span>

              {/* Energy bar */}
              <EnergyBar level={t.energy ?? 0} />

              {/* Danceability */}
              <span style={{ color: HARDWARE.textDim, fontFamily: FONTS.mono, fontSize: 10 }}>
                {t.danceability != null ? t.danceability.toFixed(2) : "—"}
              </span>

              {/* Genre */}
              <span style={{ color: HARDWARE.textDim, fontSize: 9, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {t.genres?.split(",")[0] || ""}
              </span>

              {/* Play */}
              <button onClick={() => togglePlay(t)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex", justifyContent: "center" }}>
                {currentTrackId === t.id && isPlaying
                  ? <Pause size={16} color={LED_COLORS.green.on} />
                  : <Play size={16} color={HARDWARE.textDim} />
                }
              </button>

              {/* Like */}
              <button onClick={() => toggleFeedback(t.id, true)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex", justifyContent: "center" }}>
                <Heart size={20} color={isLiked ? LED_COLORS.green.on : HARDWARE.textDim}
                       fill={isLiked ? LED_COLORS.green.on : "none"} />
              </button>

              {/* Dislike */}
              <button onClick={() => toggleFeedback(t.id, false)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex", justifyContent: "center" }}>
                <HeartOff size={20} color={isDisliked ? LED_COLORS.red.on : HARDWARE.textDim} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
