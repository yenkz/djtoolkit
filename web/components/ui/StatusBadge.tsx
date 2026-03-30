"use client";

import { LED_COLORS, FONTS, STATUS_LED, type StatusKey } from "@/lib/design-system/tokens";

interface StatusBadgeProps {
  status: string;
  label?: string;
}

export default function StatusBadge({ status, label }: StatusBadgeProps) {
  const ledKey = STATUS_LED[status as StatusKey] ?? "green";
  const c = LED_COLORS[ledKey];
  const displayLabel = label ?? status;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        fontFamily: FONTS.mono,
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase",
        color: c.on,
        background: `${c.on}15`,
        border: `1px solid ${c.on}33`,
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: c.on,
          boxShadow: c.glow,
          flexShrink: 0,
        }}
      />
      {displayLabel}
    </span>
  );
}
