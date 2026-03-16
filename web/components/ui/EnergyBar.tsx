"use client";

interface EnergyBarProps {
  level: number; // 0..1
}

export default function EnergyBar({ level }: EnergyBarProps) {
  return (
    <div style={{ display: "flex", gap: 1.5, height: 8, width: 48 }}>
      {Array.from({ length: 6 }, (_, i) => {
        const pct = (i + 1) / 6;
        const on = pct <= level;
        return (
          <div
            key={i}
            style={{
              flex: 1,
              borderRadius: 1,
              background: on
                ? pct > 0.75
                  ? "var(--led-red)"
                  : pct > 0.5
                    ? "var(--led-orange)"
                    : "var(--led-green)"
                : "var(--hw-groove)",
              opacity: on ? 0.8 : 0.2,
              transition: "all 0.2s",
            }}
          />
        );
      })}
    </div>
  );
}
