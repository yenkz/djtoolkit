"use client";

import type { Track } from "@/lib/api";

interface EnergyArcProps {
  tracks: Track[];
}

export default function EnergyArc({ tracks }: EnergyArcProps) {
  if (!tracks.length) return null;

  const maxEnergy = Math.max(...tracks.map(t => t.energy ?? 0), 0.01);

  return (
    <div style={{
      background: "var(--hw-groove)", borderRadius: 6, padding: "8px 12px",
      height: 44, display: "flex", alignItems: "flex-end", gap: 1,
    }}>
      {tracks.map((t, i) => {
        const pct = ((t.energy ?? 0) / maxEnergy) * 100;
        const hue = 210 + (pct / 100) * 30;
        return (
          <div key={t.id ?? i} style={{
            flex: 1, height: `${pct}%`, minHeight: 2,
            background: `hsl(${hue}, 70%, ${40 + pct * 0.3}%)`,
            borderRadius: "2px 2px 0 0",
          }} />
        );
      })}
    </div>
  );
}
