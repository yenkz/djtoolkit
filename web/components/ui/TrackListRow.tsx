"use client";

import { useState } from "react";
import EnergyBar from "./EnergyBar";
import StatusDot from "./StatusDot";
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
  created_at?: string;
}

interface TrackListRowProps {
  track: Track;
  onClick?: () => void;
  isLast?: boolean;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  showCheckbox?: boolean;
}

/** Deterministic color from artist name. */
function artistColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = name.charCodeAt(i) + ((h << 5) - h);
  }
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

export default function TrackListRow({
  track,
  onClick,
  isLast = false,
  selected = false,
  onSelect,
  showCheckbox = false,
}: TrackListRowProps) {
  const [hovered, setHovered] = useState(false);
  const { currentTrackId, isPlaying, play, pause } =
    usePreviewPlayer();
  const isThisPlaying = currentTrackId === track.id && isPlaying;
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
      className="cursor-pointer"
      style={{
        display: "grid",
        gridTemplateColumns: showCheckbox
          ? "28px 44px 2fr 1.5fr 50px 60px 0.5fr 0.8fr 0.6fr 48px"
          : "44px 2fr 1.5fr 50px 60px 0.5fr 0.8fr 0.6fr 48px",
        padding: "8px 14px",
        gap: 10,
        alignItems: "center",
        borderBottom: isLast
          ? "none"
          : `1px solid ${isThisActive ? `${LED.on}33` : "var(--hw-list-border)"}`,
        borderLeft: isThisActive ? `3px solid ${LED.on}` : "3px solid transparent",
        borderRight: isThisActive ? `1px solid ${LED.on}33` : "1px solid transparent",
        background: isThisActive
          ? `linear-gradient(90deg, ${LED.on}15 0%, ${LED.on}08 100%)`
          : hovered
            ? "var(--hw-list-row-hover)"
            : "var(--hw-list-row-bg)",
        boxShadow: isThisActive
          ? `${LED.glow}, inset 0 0 20px ${LED.on}08`
          : "none",
        transition: "all 0.2s ease",
      }}
    >
      {/* Checkbox */}
      {showCheckbox && (
        <div
          style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect?.(e.target.checked)}
            style={{
              width: 14,
              height: 14,
              accentColor: "var(--led-blue)",
              cursor: "pointer",
            }}
          />
        </div>
      )}

      {/* Artwork thumbnail */}
      <div style={{ position: "relative", width: 38, height: 38 }}>
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 4,
            backgroundImage: track.artwork_url
              ? `url(${track.artwork_url})`
              : `linear-gradient(135deg, ${color}44 0%, ${color}11 100%)`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {!track.artwork_url && (
            <span
              className="font-sans"
              style={{
                fontSize: 13,
                fontWeight: 800,
                color: `${color}88`,
              }}
            >
              {initials}
            </span>
          )}
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
              borderRadius: 4,
              background: "rgba(0,0,0,0.5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: "rgba(0,0,0,0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: `1.5px solid ${LED.on}`,
                boxShadow: LED.glow,
              }}
            >
              {isThisPlaying ? (
                <svg width="8" height="10" viewBox="0 0 12 14">
                  <rect x="1" y="0" width="3.5" height="14" rx="1" fill={LED.on} />
                  <rect x="7.5" y="0" width="3.5" height="14" rx="1" fill={LED.on} />
                </svg>
              ) : (
                <svg width="8" height="8" viewBox="0 0 24 24">
                  <path d="M6 3l12 9-12 9V3z" fill={LED.on} />
                </svg>
              )}
            </div>
          </div>
        )}

      </div>

      {/* Track + album */}
      <div style={{ overflow: "hidden" }}>
        <div
          className="font-sans truncate"
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: isThisActive ? LED.on : "var(--hw-text)",
          }}
        >
          {track.title}
        </div>
        {track.album && (
          <div
            className="font-sans truncate"
            style={{
              fontSize: 11,
              color: "var(--hw-text-dim)",
            }}
          >
            {track.album}
          </div>
        )}
      </div>

      {/* Artist */}
      <span
        className="font-sans truncate"
        style={{ fontSize: 12, color: "var(--hw-text-sec)" }}
      >
        {track.artist}
      </span>

      {/* BPM */}
      <span
        className="font-mono"
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: hovered ? "var(--led-blue)" : "var(--led-blue-dim)",
          transition: "color 0.2s",
        }}
      >
        {track.bpm ?? "--"}
      </span>

      {/* Key */}
      <span
        className="font-mono"
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: hovered ? "var(--led-green)" : "var(--led-green-dim, var(--hw-text-dim))",
          transition: "color 0.2s",
        }}
      >
        {track.key ?? "--"}
      </span>

      {/* Energy bar */}
      <EnergyBar level={track.energy ?? 0} />

      {/* Tags */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {tags.slice(0, 2).map((t) => (
          <Tag key={t} label={t} />
        ))}
      </div>

      {/* Added date */}
      <span
        className="font-mono"
        style={{ fontSize: 10, color: "var(--hw-text-muted)" }}
      >
        {track.created_at
          ? new Date(track.created_at).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "2-digit",
            })
          : ""}
      </span>

      {/* Status */}
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        {track.status && <StatusDot status={track.status} />}
      </div>
    </div>
  );
}
