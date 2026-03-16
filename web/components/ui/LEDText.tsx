"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { LED_COLORS, type LEDColor } from "@/lib/design-system/tokens";

interface LEDTextProps {
  children: ReactNode;
  color?: LEDColor;
  alwaysOn?: boolean;
  style?: CSSProperties;
}

export default function LEDText({
  children,
  color = "green",
  alwaysOn = false,
  style = {},
}: LEDTextProps) {
  const [hovered, setHovered] = useState(false);
  const c = LED_COLORS[color];
  const active = hovered || alwaysOn;

  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...style,
        color: active ? c.on : c.dim,
        textShadow: active ? c.glow : "none",
        transition: "color 0.3s, text-shadow 0.3s",
        cursor: "default",
      }}
    >
      {children}
    </span>
  );
}
