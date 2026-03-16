"use client";

import { useState } from "react";
import StatusDot from "./StatusDot";
import EnergyBar from "./EnergyBar";

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

interface TrackCompactRowProps {
  track: Track;
  onClick?: () => void;
  isLast?: boolean;
}

export default function TrackCompactRow({
  track,
  onClick,
  isLast = false,
}: TrackCompactRowProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      className="cursor-pointer"
      style={{
        display: "grid",
        gridTemplateColumns: "6px 2fr 1.5fr 0.6fr 0.5fr 0.6fr 0.5fr",
        padding: "6px 14px",
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
      {/* Status dot */}
      <StatusDot status={track.status ?? "available"} />

      {/* Track title */}
      <span
        className="font-sans truncate"
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--hw-text)",
        }}
      >
        {track.title}
      </span>

      {/* Artist */}
      <span
        className="font-sans truncate"
        style={{ fontSize: 11, color: "var(--hw-text-sec)" }}
      >
        {track.artist}
      </span>

      {/* BPM */}
      <span
        className="font-mono"
        style={{ fontSize: 10, color: "var(--led-blue-dim)" }}
      >
        {track.bpm ?? "--"}
      </span>

      {/* Key */}
      <span
        className="font-mono"
        style={{ fontSize: 10, color: "var(--hw-text-dim)" }}
      >
        {track.key ?? "--"}
      </span>

      {/* Genre */}
      <span
        className="font-mono"
        style={{ fontSize: 9, color: "var(--hw-text-dim)" }}
      >
        {track.genre ?? ""}
      </span>

      {/* Energy */}
      <EnergyBar level={track.energy ?? 0} />
    </div>
  );
}
