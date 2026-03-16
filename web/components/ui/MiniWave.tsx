"use client";

import { useMemo } from "react";

interface MiniWaveProps {
  data?: number[];
  color?: string;
}

/**
 * Deterministic pseudo-random data generator seeded by a simple hash.
 * Used when no waveform data is provided.
 */
function generateData(seed: number = 42): number[] {
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < 20; i++) {
    s = (s * 16807 + 7) % 2147483647;
    out.push(2 + (s % 9)); // range 2..10
  }
  return out;
}

export default function MiniWave({
  data,
  color = "var(--led-blue)",
}: MiniWaveProps) {
  const bars = useMemo(() => data ?? generateData(), [data]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 1,
        height: 24,
        width: 60,
      }}
    >
      {bars.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${v * 10}%`,
            background: color,
            borderRadius: 0.5,
            opacity: 0.6,
          }}
        />
      ))}
    </div>
  );
}
