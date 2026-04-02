"use client";

import { useState } from "react";
import { Heart, HeartOff, Play, Pause, RefreshCw, Download } from "lucide-react";
import { usePreviewPlayer } from "@/lib/preview-player-context";
import type { Track } from "@/lib/api";
import EnergyArc from "./EnergyArc";
import { HARDWARE, LED_COLORS } from "@/lib/design-system/tokens";

interface ResultsListProps {
  tracks: Track[];
  onRefine: (feedback: { track_id: number; liked: boolean }[]) => void;
  onExport: () => void;
  refining: boolean;
}

export default function ResultsList({ tracks, onRefine, onExport, refining }: ResultsListProps) {
  const [feedback, setFeedback] = useState<Record<number, boolean>>({});
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

  const totalMs = tracks.reduce((sum, t) => sum + ((t as Record<string, unknown>).duration_ms as number ?? 0), 0);
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

      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 8 }}>
        {tracks.map((t, i) => (
          <div key={t.id} style={{
            display: "flex", alignItems: "center", gap: 8, padding: "5px 8px",
            background: HARDWARE.groove, borderRadius: 4, fontSize: 12,
          }}>
            <span style={{ color: HARDWARE.textDim, width: 24, textAlign: "right" }}>{i + 1}</span>
            <div style={{ flex: 1, color: HARDWARE.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {t.artist} &mdash; {t.title}
            </div>
            <span style={{ color: HARDWARE.textDim }}>{Math.round(t.tempo ?? 0)}</span>
            <span style={{ color: HARDWARE.textDim }}>{t.key_normalized || ""}</span>
            <span style={{ color: (t.energy ?? 0) > 0.7 ? LED_COLORS.orange.on : LED_COLORS.green.on }}>
              E {t.energy?.toFixed(2)}
            </span>
            <button onClick={() => togglePlay(t)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}>
              {currentTrackId === t.id && isPlaying
                ? <Pause size={14} color={LED_COLORS.green.on} />
                : <Play size={14} color={HARDWARE.textDim} />
              }
            </button>
            <button onClick={() => toggleFeedback(t.id, true)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}>
              <Heart size={14} color={feedback[t.id] === true ? LED_COLORS.green.on : HARDWARE.textDim}
                     fill={feedback[t.id] === true ? LED_COLORS.green.on : "none"} />
            </button>
            <button onClick={() => toggleFeedback(t.id, false)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}>
              <HeartOff size={14} color={feedback[t.id] === false ? LED_COLORS.red.on : HARDWARE.textDim} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
