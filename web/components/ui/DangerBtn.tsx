"use client";

import { useState, type ReactNode } from "react";

interface DangerBtnProps {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

export default function DangerBtn({
  children,
  onClick,
  disabled = false,
}: DangerBtnProps) {
  const [hover, setHover] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={disabled}
      className="font-mono cursor-pointer transition-all duration-150 whitespace-nowrap"
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase",
        padding: "8px 18px",
        borderRadius: 5,
        background: hover
          ? "color-mix(in srgb, var(--led-red) 8%, transparent)"
          : "transparent",
        color: "var(--hw-error-text)",
        border: `1.5px solid ${
          hover
            ? "color-mix(in srgb, var(--led-red) 20%, transparent)"
            : "var(--hw-border-light)"
        }`,
        boxShadow: hover ? "0 0 12px color-mix(in srgb, var(--led-red) 20%, transparent)" : "none",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}
