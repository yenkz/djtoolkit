"use client";

import { useState } from "react";
import { LED_COLORS, STEEL, HARDWARE, FONTS } from "@/lib/design-system/tokens";

const LED = LED_COLORS.green;

interface CDJPlayButtonProps {
  size?: number;
  label?: string;
  onClick?: () => void;
}

export default function CDJPlayButton({
  size = 80,
  label = "GET STARTED",
  onClick,
}: CDJPlayButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const ringColor = pressed ? LED.on : hovered ? LED.mid : LED.dim;
  const ringGlow = pressed ? LED.glowHot : hovered ? LED.glow : "none";
  const ringWidth = pressed ? 5 : hovered ? 4 : 3;
  const iconColor = pressed ? LED.on : hovered ? "#ddd" : "#999";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
      <div
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false);
          setPressed(false);
        }}
        onMouseDown={() => setPressed(true)}
        onMouseUp={() => setPressed(false)}
        role="button"
        tabIndex={0}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          position: "relative",
          cursor: "pointer",
          background: `radial-gradient(circle at 50% 50%, ${HARDWARE.raised} 0%, ${HARDWARE.groove} 100%)`,
          boxShadow: `inset 0 2px 4px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4), ${ringGlow}`,
          transform: pressed ? "scale(0.96)" : "scale(1)",
          transition: "box-shadow 0.25s, transform 0.15s",
        }}
      >
        {/* Green LED ring */}
        <div
          style={{
            position: "absolute",
            inset: 3,
            borderRadius: "50%",
            border: `${ringWidth}px solid ${ringColor}`,
            boxShadow: `inset 0 0 ${pressed ? 12 : hovered ? 8 : 3}px ${ringColor}${pressed ? "88" : hovered ? "55" : "22"}, 0 0 ${pressed ? 16 : hovered ? 10 : 0}px ${ringColor}${pressed ? "66" : hovered ? "44" : "00"}`,
            transition: "all 0.2s",
          }}
        />

        {/* Brushed steel disc */}
        <div
          style={{
            position: "absolute",
            inset: pressed ? 13 : 12,
            borderRadius: "50%",
            background: `radial-gradient(circle at 40% 35%, rgba(255,255,255,0.12) 0%, transparent 50%), ${STEEL.conic}`,
            boxShadow:
              "inset 0 1px 2px rgba(255,255,255,0.15), inset 0 -1px 2px rgba(0,0,0,0.3)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "all 0.15s",
          }}
        >
          <svg
            width={size * 0.28}
            height={size * 0.28}
            viewBox="0 0 24 24"
            fill="none"
          >
            <path
              d="M6 3l12 9-12 9V3z"
              fill={iconColor}
              style={{
                filter: pressed
                  ? `drop-shadow(0 0 4px ${LED.on})`
                  : "none",
                transition: "all 0.2s",
              }}
            />
            <rect
              x="18"
              y="5"
              width="2"
              height="14"
              rx="0.5"
              fill={iconColor}
              opacity="0.5"
              style={{ transition: "all 0.2s" }}
            />
          </svg>
        </div>
      </div>

      {label && (
        <span
          style={{
            fontFamily: FONTS.mono,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: 2,
            textTransform: "uppercase",
            color: hovered || pressed ? LED.on : HARDWARE.textDim,
            textShadow: hovered || pressed ? LED.glow : "none",
            transition: "all 0.25s",
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
