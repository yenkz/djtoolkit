"use client";

import { useState } from "react";
import MiniWave from "./MiniWave";
import EnergyBar from "./EnergyBar";
import StatusDot from "./StatusDot";
import Tag from "./Tag";

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
}

interface TrackListRowProps {
  track: Track;
  onClick?: () => void;
  isLast?: boolean;
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
}: TrackListRowProps) {
  const [hovered, setHovered] = useState(false);
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
        gridTemplateColumns: "44px 2fr 1.5fr 60px 0.7fr 0.5fr 1fr 48px",
        padding: "8px 14px",
        gap: 10,
        alignItems: "center",
        borderBottom: isLast
          ? "none"
          : "1px solid var(--hw-list-border)",
        background: hovered
          ? "var(--hw-list-row-hover)"
          : "var(--hw-list-row-bg)",
        transition: "background 0.12s",
      }}
    >
      {/* Artwork thumbnail */}
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

      {/* Track + album */}
      <div style={{ overflow: "hidden" }}>
        <div
          className="font-sans truncate"
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--hw-text)",
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

      {/* Mini waveform */}
      <div style={{ width: 48 }}>
        <MiniWave color={color} />
      </div>

      {/* BPM + Key */}
      <span
        className="font-mono"
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: hovered ? "var(--led-blue)" : "var(--led-blue-dim)",
          transition: "color 0.2s",
        }}
      >
        {track.bpm ?? "--"} · {track.key ?? "--"}
      </span>

      {/* Energy bar */}
      <EnergyBar level={track.energy ?? 0} />

      {/* Tags */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {tags.slice(0, 2).map((t) => (
          <Tag key={t} label={t} />
        ))}
      </div>

      {/* Status */}
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        {track.status && <StatusDot status={track.status} />}
      </div>
    </div>
  );
}
