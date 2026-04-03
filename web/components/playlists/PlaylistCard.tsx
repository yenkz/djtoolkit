"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Trash2, Clock, Music } from "lucide-react";
import EnergyArc from "@/components/recommend/EnergyArc";
import type { Playlist } from "@/lib/api";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";

interface PlaylistCardProps {
  playlist: Playlist;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  children?: React.ReactNode;
}

function formatRelativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function PlaylistCard({ playlist, expanded, onToggle, onDelete, children }: PlaylistCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const totalMin = Math.floor(playlist.total_duration_ms / 60000);
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;

  const contextLabel = playlist.venue_name || playlist.mood_name || null;

  return (
    <div style={{
      background: HARDWARE.surface,
      border: `1px solid ${expanded ? LED_COLORS.blue.mid : HARDWARE.border}`,
      borderRadius: 8,
      transition: "border-color 0.15s ease",
    }}>
      {/* Card header — clickable */}
      <button
        onClick={onToggle}
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto auto",
          gap: 12,
          alignItems: "center",
          width: "100%",
          padding: "14px 16px",
          background: "none",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ color: HARDWARE.text, fontSize: 15, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {playlist.name}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 3, color: HARDWARE.textDim, fontSize: 12 }}>
              <Music size={11} /> {playlist.track_count} tracks
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 3, color: HARDWARE.textDim, fontSize: 12 }}>
              <Clock size={11} /> {hrs > 0 ? `${hrs}h ` : ""}{mins}m
            </span>
            <span style={{ color: HARDWARE.textDim, fontSize: 11 }}>
              {formatRelativeDate(playlist.created_at)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            {contextLabel && (
              <span style={{
                fontSize: 10, padding: "2px 8px", borderRadius: 4,
                background: "rgba(68,136,255,0.1)", color: LED_COLORS.blue.on,
              }}>
                {contextLabel}
              </span>
            )}
            {playlist.lineup_position && (
              <span style={{
                fontSize: 10, padding: "2px 8px", borderRadius: 4,
                background: "rgba(255,160,51,0.1)", color: LED_COLORS.orange.on,
              }}>
                {playlist.lineup_position}
              </span>
            )}
          </div>
        </div>

        {/* Mini energy arc */}
        {playlist.energies.length > 0 && (
          <div style={{ width: 120, height: 28, overflow: "hidden" }}>
            <EnergyArc tracks={playlist.energies.map(e => ({ energy: e } as never))} />
          </div>
        )}

        <div style={{ color: HARDWARE.textDim }}>
          {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${HARDWARE.border}`, padding: "0 16px 16px" }}>
          {/* Action bar */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, padding: "12px 0 8px" }}>
            {confirmDelete ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: LED_COLORS.red.on, fontSize: 12 }}>Delete this playlist?</span>
                <button
                  onClick={() => { onDelete(); setConfirmDelete(false); }}
                  style={{
                    padding: "4px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer",
                    background: LED_COLORS.red.on, color: "#fff", border: "none",
                  }}
                >
                  Yes, delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  style={{
                    padding: "4px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer",
                    background: HARDWARE.raised, color: HARDWARE.textDim, border: "none",
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                  background: "none", color: HARDWARE.textDim, border: `1px solid ${HARDWARE.border}`,
                }}
              >
                <Trash2 size={12} /> Delete
              </button>
            )}
          </div>
          {children}
        </div>
      )}
    </div>
  );
}
