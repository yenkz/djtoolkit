"use client";

import { HARDWARE, LED_COLORS, type LEDColor } from "@/lib/design-system/tokens";

interface VUMeterProps {
  level?: number;
  segments?: number;
  color?: LEDColor;
  height?: number;
}

export default function VUMeter({
  level = 0.7,
  segments = 12,
  color = "green",
  height = 100,
}: VUMeterProps) {
  const c = LED_COLORS[color];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column-reverse",
        gap: 2,
        width: "clamp(12px, 2vw, 16px)",
        height,
      }}
    >
      {Array.from({ length: segments }, (_, i) => {
        const pct = (i + 1) / segments;
        const active = pct <= level;
        const isHot = pct > 0.75;
        const isMid = pct > 0.5;
        const barColor = active
          ? isHot
            ? LED_COLORS.red.on
            : isMid
              ? LED_COLORS.orange.on
              : c.on
          : HARDWARE.raised;
        const barGlow = active
          ? isHot
            ? LED_COLORS.red.glow
            : isMid
              ? LED_COLORS.orange.glow
              : c.glow
          : "none";

        return (
          <div
            key={i}
            style={{
              flex: 1,
              borderRadius: 1,
              background: barColor,
              opacity: active ? 0.9 : 0.3,
              boxShadow: barGlow,
              transition: "all 0.15s",
            }}
          />
        );
      })}
    </div>
  );
}
