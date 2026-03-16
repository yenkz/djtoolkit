"use client";

import { useState } from "react";
import { PAD_COLORS, RUBBER, FONTS, type LEDColor } from "@/lib/design-system/tokens";

const SIZES = {
  small: { h: 72, labelSize: 8, dotSize: 5 },
  medium: { h: 100, labelSize: 9, dotSize: 6 },
  large: { h: 130, labelSize: 10, dotSize: 7 },
} as const;

interface LaunchPadProps {
  label: string;
  sublabel?: string;
  color?: LEDColor;
  size?: keyof typeof SIZES;
  onPress?: () => void;
}

export default function LaunchPad({
  label,
  sublabel,
  color = "green",
  size = "medium",
  onPress,
}: LaunchPadProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const c = PAD_COLORS[color];
  const s = SIZES[size];

  const padBg = pressed
    ? `linear-gradient(180deg, color-mix(in srgb, white 55%, ${c.on}) 0%, color-mix(in srgb, white 40%, ${c.on}) 50%, color-mix(in srgb, white 50%, ${c.on}) 100%)`
    : hovered
      ? "linear-gradient(180deg, rgba(255,255,255,0.92) 0%, rgba(250,250,245,0.85) 50%, rgba(245,245,240,0.80) 100%)"
      : `linear-gradient(180deg, ${RUBBER.pad} 0%, #CCC9BE 100%)`;

  const borderColor = pressed
    ? c.on
    : hovered
      ? "rgba(255,255,255,0.6)"
      : RUBBER.padEdge;

  const shadow = pressed
    ? `${c.glowHot}, inset 0 0 30px ${c.on}44, inset 0 1px 0 rgba(255,255,255,0.3), 0 0 24px ${c.on}33`
    : hovered
      ? "0 0 20px rgba(255,255,255,0.25), inset 0 0 24px rgba(255,255,255,0.3), inset 0 1px 0 rgba(255,255,255,0.5), 0 0 12px rgba(255,255,255,0.15)"
      : `inset 0 1px 0 ${RUBBER.highlight}, inset 0 -1px 2px ${RUBBER.shadow}, 0 1px 3px ${RUBBER.shadow}`;

  const ledColor = pressed
    ? c.on
    : hovered
      ? "rgba(255,255,255,0.9)"
      : c.dim;
  const ledShadow = pressed
    ? `0 0 12px ${c.on}, 0 0 24px ${c.on}88`
    : hovered
      ? "0 0 10px rgba(255,255,255,0.7), 0 0 20px rgba(255,255,255,0.3)"
      : `0 0 3px ${c.dim}`;

  const textColor = pressed ? c.on : hovered ? "#333" : c.dim;
  const textGlow = pressed
    ? `0 0 8px ${c.on}88, 0 0 16px ${c.on}44`
    : "none";
  const subColor = pressed
    ? `${c.on}bb`
    : hovered
      ? "#555"
      : `${c.dim}88`;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onClick={onPress}
      role="button"
      tabIndex={0}
      style={{
        height: s.h,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        cursor: "pointer",
        position: "relative",
        overflow: "hidden",
        borderRadius: 5,
        background: padBg,
        border: `1.5px solid ${borderColor}`,
        boxShadow: shadow,
        transform: pressed ? "scale(0.96) translateY(1px)" : "scale(1)",
        transition: "all 0.15s ease-out",
      }}
    >
      {/* Backlight hotspot */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: pressed ? "110%" : hovered ? "100%" : "40%",
          height: pressed ? "110%" : hovered ? "100%" : "40%",
          borderRadius: "50%",
          background: pressed
            ? `radial-gradient(circle, ${c.on}55 0%, ${c.on}22 40%, transparent 70%)`
            : hovered
              ? "radial-gradient(circle, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0.15) 40%, transparent 70%)"
              : "radial-gradient(circle, rgba(255,255,255,0.05) 0%, transparent 70%)",
          transition: "all 0.2s ease-out",
          pointerEvents: "none",
        }}
      />

      {/* LED dot */}
      <div
        style={{
          width: pressed ? s.dotSize + 3 : hovered ? s.dotSize + 1 : s.dotSize,
          height: pressed
            ? s.dotSize + 3
            : hovered
              ? s.dotSize + 1
              : s.dotSize,
          borderRadius: "50%",
          background: ledColor,
          boxShadow: ledShadow,
          transition: "all 0.15s",
          position: "relative",
          zIndex: 1,
        }}
      />

      {/* Label */}
      <div
        style={{
          fontFamily: FONTS.mono,
          fontSize: s.labelSize,
          fontWeight: 700,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: textColor,
          textShadow: textGlow,
          transition: "all 0.15s",
          position: "relative",
          zIndex: 1,
        }}
      >
        {label}
      </div>

      {/* Sublabel */}
      {sublabel && (
        <div
          style={{
            fontFamily: FONTS.mono,
            fontSize: Math.max(7, s.labelSize - 2),
            color: subColor,
            letterSpacing: 0.5,
            transition: "all 0.15s",
            position: "relative",
            zIndex: 1,
          }}
        >
          {sublabel}
        </div>
      )}
    </div>
  );
}
