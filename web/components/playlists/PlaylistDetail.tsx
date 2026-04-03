"use client";

import { useState, useCallback, useEffect } from "react";
import { GripVertical, X, Play, Pause, Download, RefreshCw, Save, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { usePreviewPlayer } from "@/lib/preview-player-context";
import EnergyBar from "@/components/ui/EnergyBar";
import ExportDialog from "@/components/recommend/ExportDialog";
import { fetchPlaylist, updatePlaylist, type PlaylistDetail as PlaylistDetailType, type Track } from "@/lib/api";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";
import { toast } from "sonner";

interface PlaylistDetailProps {
  playlistId: string;
  sessionId: string | null;
  playlistName: string;
}

export default function PlaylistDetail({ playlistId, sessionId, playlistName }: PlaylistDetailProps) {
  const [detail, setDetail] = useState<PlaylistDetailType | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [name, setName] = useState(playlistName);
  const [editingName, setEditingName] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const { currentTrackId, isPlaying, play, playUrl, pause } = usePreviewPlayer();
  const router = useRouter();

  useEffect(() => {
    fetchPlaylist(playlistId)
      .then((d) => {
        setDetail(d);
        setTracks(d.tracks);
        setName(d.name);
        setLoading(false);
      })
      .catch((err) => {
        toast.error(err.message);
        setLoading(false);
      });
  }, [playlistId]);

  const handleRemoveTrack = useCallback((trackId: number) => {
    setTracks((prev) => prev.filter((t) => t.id !== trackId));
    setDirty(true);
  }, []);

  const handleDrop = useCallback((dropIdx: number) => {
    if (dragIdx === null || dragIdx === dropIdx) return;
    setTracks((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(dropIdx, 0, moved);
      return next;
    });
    setDragIdx(null);
    setDirty(true);
  }, [dragIdx]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const data: { name?: string; tracks?: number[] } = {};
      if (name !== detail?.name) data.name = name;
      data.tracks = tracks.map((t) => t.id);
      await updatePlaylist(playlistId, data);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success("Playlist saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [playlistId, name, tracks, detail]);

  const handleNameChange = useCallback((newName: string) => {
    setName(newName);
    if (newName !== detail?.name) setDirty(true);
  }, [detail]);

  const togglePlay = (track: Track) => {
    if (currentTrackId === track.id && isPlaying) {
      pause();
    } else if (track.spotify_uri) {
      play(track.id, track.spotify_uri);
    } else if (track.preview_url) {
      playUrl(track.id, track.preview_url, { title: track.title, artist: track.artist });
    }
  };

  if (loading) {
    return <div style={{ color: HARDWARE.textDim, fontSize: 12, padding: "12px 0" }}>Loading tracks...</div>;
  }

  return (
    <div>
      {/* Name + actions */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div>
          {editingName ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => { if (e.key === "Enter") setEditingName(false); }}
              style={{
                background: HARDWARE.groove, border: `1px solid ${LED_COLORS.blue.mid}`,
                color: HARDWARE.text, fontSize: 14, fontWeight: 600, padding: "2px 8px",
                borderRadius: 4, outline: "none", width: 260,
              }}
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              style={{ background: "none", border: "none", color: HARDWARE.text, fontSize: 14, fontWeight: 600, cursor: "pointer", padding: 0 }}
              title="Click to rename"
            >
              {name}
            </button>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {sessionId && (
            <>
              <button
                onClick={() => setShowExport(true)}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "4px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                  background: LED_COLORS.green.mid, color: "#fff", border: "none",
                }}
              >
                <Download size={12} /> Re-export
              </button>
              <button
                onClick={() => router.push(`/recommend?session=${sessionId}`)}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "4px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                  background: LED_COLORS.blue.mid, color: "#fff", border: "none",
                }}
              >
                <RefreshCw size={12} /> Continue Refining
              </button>
            </>
          )}
          {dirty && (
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "4px 14px", borderRadius: 6, fontSize: 11, cursor: saving ? "wait" : "pointer",
                background: saved ? LED_COLORS.green.on : LED_COLORS.blue.on, color: "#fff", border: "none",
                fontWeight: 600,
              }}
            >
              {saved ? <><Check size={12} /> Saved</> : saving ? "Saving..." : <><Save size={12} /> Save</>}
            </button>
          )}
        </div>
      </div>

      {/* Column header */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "24px 28px 36px 1fr 50px 50px 48px 42px 50px 30px 28px",
        gap: 6, alignItems: "center", padding: "4px 8px",
        fontSize: 9, color: HARDWARE.textDim, textTransform: "uppercase", letterSpacing: 0.5,
        borderBottom: `1px solid ${HARDWARE.border}`, marginBottom: 2,
      }}>
        <span />
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
      </div>

      {/* Track list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {tracks.map((t, i) => {
          const isHovered = hoverIdx === i;
          return (
            <div
              key={t.id}
              draggable
              onDragStart={() => setDragIdx(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(i)}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              style={{
                display: "grid",
                gridTemplateColumns: "24px 28px 36px 1fr 50px 50px 48px 42px 50px 30px 28px",
                gap: 6, alignItems: "center", padding: "4px 8px",
                background: isHovered ? "rgba(68,136,255,0.08)" : HARDWARE.groove,
                borderRadius: 4, fontSize: 12,
                transition: "background 0.12s ease",
              }}
            >
              <GripVertical size={12} style={{ color: HARDWARE.textDim, cursor: "grab" }} />
              <span style={{ color: HARDWARE.textDim, textAlign: "right", fontFamily: FONTS.mono, fontSize: 11 }}>{i + 1}</span>

              {t.artwork_url ? (
                <img src={t.artwork_url} alt="" style={{ width: 32, height: 32, borderRadius: 3, objectFit: "cover" }} />
              ) : (
                <div style={{ width: 32, height: 32, borderRadius: 3, background: HARDWARE.raised }} />
              )}

              <div style={{ minWidth: 0 }}>
                <div style={{ color: HARDWARE.text, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.title}
                </div>
                <div style={{ color: HARDWARE.textDim, fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.artist}
                </div>
              </div>

              <span style={{ color: HARDWARE.textDim, fontFamily: FONTS.mono, fontSize: 11, textAlign: "right" }}>
                {Math.round(t.tempo ?? 0)}
              </span>
              <span style={{ color: HARDWARE.textDim, fontFamily: FONTS.mono, fontSize: 11 }}>
                {t.key_normalized || ""}
              </span>
              <EnergyBar level={t.energy ?? 0} />
              <span style={{ color: HARDWARE.textDim, fontFamily: FONTS.mono, fontSize: 10 }}>
                {t.danceability != null ? t.danceability.toFixed(2) : "—"}
              </span>
              <span style={{ color: HARDWARE.textDim, fontSize: 9, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {t.genres?.split(",")[0] || ""}
              </span>

              <button onClick={() => togglePlay(t)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex", justifyContent: "center" }}>
                {currentTrackId === t.id && isPlaying
                  ? <Pause size={16} color={LED_COLORS.green.on} />
                  : <Play size={16} color={HARDWARE.textDim} />
                }
              </button>

              <button
                onClick={() => handleRemoveTrack(t.id)}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex", justifyContent: "center" }}
                title="Remove track"
              >
                <X size={14} color={isHovered ? LED_COLORS.red.on : HARDWARE.textDim} />
              </button>
            </div>
          );
        })}
      </div>

      {showExport && sessionId && (
        <ExportDialog
          sessionId={sessionId}
          defaultName={name}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}
