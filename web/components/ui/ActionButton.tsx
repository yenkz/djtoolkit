"use client";

import { useState, type ReactNode, type ButtonHTMLAttributes } from "react";
import { LED_COLORS, HARDWARE, FONTS } from "@/lib/design-system/tokens";

interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "outline" | "ghost";
  children: ReactNode;
  icon?: ReactNode;
}

export default function ActionButton({
  variant = "primary",
  children,
  icon,
  ...props
}: ActionButtonProps) {
  const [hovered, setHovered] = useState(false);
  const c = LED_COLORS.blue;

  const styles: Record<string, React.CSSProperties> = {
    primary: {
      background: hovered ? c.on : c.mid,
      color: HARDWARE.body,
      border: `1.5px solid ${hovered ? c.on : c.mid}`,
      boxShadow: hovered ? c.glow : "none",
    },
    outline: {
      background: "transparent",
      color: hovered ? c.on : c.dim,
      border: `1.5px solid ${hovered ? c.on : HARDWARE.border}`,
      boxShadow: hovered ? `0 0 12px ${c.on}22` : "none",
    },
    ghost: {
      background: hovered ? `${HARDWARE.raised}` : "transparent",
      color: hovered ? HARDWARE.text : HARDWARE.textDim,
      border: "1.5px solid transparent",
      boxShadow: "none",
    },
  };

  return (
    <button
      {...props}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 16px",
        fontFamily: FONTS.mono,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1.5,
        textTransform: "uppercase",
        borderRadius: 0,
        cursor: props.disabled ? "not-allowed" : "pointer",
        opacity: props.disabled ? 0.5 : 1,
        transition: "all 0.2s",
        ...styles[variant],
        ...props.style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}
