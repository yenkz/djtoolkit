"use client";

import { useState } from "react";
import MiniWave from "./MiniWave";
import EnergyBar from "./EnergyBar";
import Tag from "./Tag";
import { usePreviewPlayer } from "@/lib/preview-player-context";
import { LED_COLORS } from "@/lib/design-system/tokens";

interface Track {
  id: number;
  title: string;
  artist: string;
  album?: string;
  bpm?: number;
  key?: string;
  genre?: string;
  energy?: number;
  status?: string;
  artwork_url?: string;
  preview_url?: string;
  spotify_uri?: string;
  enriched_audio?: boolean;
}

interface TrackCardProps {
  track: Track;
  onClick?: () => void;
}

/** Deterministic color from artist name for gradient fallback. */
function artistColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = name.charCodeAt(i) + ((h << 5) - h);
  }
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

export default function TrackCard({ track, onClick }: TrackCardProps) {
  const [hovered, setHovered] = useState(false);
  const { currentTrackId, isPlaying, play, pause } =
    usePreviewPlayer();
  const isThisPlaying =
    currentTrackId === track.id && isPlaying;
  const isThisPaused =
    currentTrackId === track.id && !isPlaying;
  const isThisActive = currentTrackId === track.id;
  const LED = LED_COLORS.green;
  const color = artistColor(track.artist);
  const initials = track.artist.slice(0, 2).toUpperCase();
  const tags = track.genre ? [track.genre] : [];

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      className="cursor-pointer overflow-hidden"
      style={{
        background: hovered
          ? "var(--hw-card-hover)"
          : "var(--hw-card-bg)",
        border: `2px solid ${isThisActive ? LED.on : hovered ? "var(--hw-border-light)" : "var(--hw-card-border)"}`,
        borderRadius: 8,
        boxShadow: isThisActive
          ? LED.glowHot
          : hovered
            ? "0 4px 16px rgba(0,0,0,0.1)"
            : "0 1px 3px rgba(0,0,0,0.04)",
        transform: hovered ? "translateY(-2px)" : "none",
        transition: "all 0.2s ease",
      }}
    >
      {/* Artwork / gradient header */}
      <div
        style={{
          height: 140,
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundImage: track.artwork_url
            ? `url(${track.artwork_url})`
            : `linear-gradient(135deg, ${color}44 0%, ${color}11 100%)`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        {/* Initials fallback when no artwork */}
        {!track.artwork_url && (
          <span
            className="font-sans"
            style={{
              fontSize: 36,
              fontWeight: 900,
              color: `${color}88`,
              letterSpacing: -2,
            }}
          >
            {initials}
          </span>
        )}

        {/* Waveform overlay at bottom */}
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            padding: "0 12px 8px",
          }}
        >
          <MiniWave color={color} />
        </div>

        {/* Play/Pause overlay */}
        {track.spotify_uri && (hovered || isThisActive) && (
          <div
            role="button"
            tabIndex={0}
            aria-label={isThisPlaying ? "Pause preview" : "Play preview"}
            onClick={(e) => {
              e.stopPropagation();
              if (isThisPlaying) {
                pause();
              } else {
                play(track.id, track.spotify_uri!);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                if (isThisPlaying) pause();
                else play(track.id, track.spotify_uri!);
              }
            }}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.45)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              zIndex: 2,
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: "50%",
                background: "rgba(0,0,0,0.6)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: `2px solid ${LED.on}`,
                boxShadow: LED.glow,
                backdropFilter: "blur(4px)",
              }}
            >
              {isThisPlaying ? (
                <svg width="12" height="14" viewBox="0 0 12 14">
                  <rect x="1" y="0" width="3.5" height="14" rx="1" fill={LED.on} />
                  <rect x="7.5" y="0" width="3.5" height="14" rx="1" fill={LED.on} />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24">
                  <path d="M6 3l12 9-12 9V3z" fill={LED.on} />
                </svg>
              )}
            </div>
          </div>
        )}

        {/* Metadata status top-right */}
        <div
          title={track.enriched_audio ? "Metadata complete" : "Needs analysis"}
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: track.enriched_audio ? "var(--led-green)" : "var(--led-orange)",
              boxShadow: track.enriched_audio
                ? "0 0 6px rgba(68,255,68,0.27)"
                : "0 0 6px rgba(255,160,51,0.27)",
            }}
          />
          <span
            className="font-mono uppercase"
            style={{
              fontSize: 8,
              color: "var(--hw-text-muted)",
              letterSpacing: 0.5,
            }}
          >
            {track.enriched_audio ? "analyzed" : "pending"}
          </span>
        </div>

        {/* BPM + Key badges top-left */}
        <div
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            display: "flex",
            gap: 6,
          }}
        >
          {track.bpm != null && (
            <span
              className="font-mono"
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#fff",
                background: "rgba(0,0,0,0.5)",
                padding: "2px 7px",
                borderRadius: 3,
                backdropFilter: "blur(4px)",
              }}
            >
              {track.bpm}
            </span>
          )}
          {track.key && (
            <span
              className="font-mono"
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#fff",
                background: "rgba(0,0,0,0.5)",
                padding: "2px 7px",
                borderRadius: 3,
                backdropFilter: "blur(4px)",
              }}
            >
              {track.key}
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "12px 14px 14px" }}>
        <div
          className="font-sans truncate"
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: isThisActive ? LED.on : "var(--hw-text)",
            lineHeight: 1.3,
            marginBottom: 2,
          }}
        >
          {track.title}
        </div>
        <div
          className="font-sans truncate"
          style={{
            fontSize: 12,
            color: "var(--hw-text-sec)",
            marginBottom: 8,
          }}
        >
          {track.artist}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <EnergyBar level={track.energy ?? 0} />
          {track.genre && (
            <span
              className="font-mono"
              style={{ fontSize: 10, color: "var(--hw-text-dim)" }}
            >
              {track.genre}
            </span>
          )}
        </div>

        {tags.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {tags.map((t) => (
              <Tag key={t} label={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
