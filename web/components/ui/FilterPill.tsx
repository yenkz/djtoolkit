"use client";

import { useState, useCallback, type KeyboardEvent } from "react";

interface FilterPillProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

export default function FilterPill({ label, active, onClick }: FilterPillProps) {
  const [hovered, setHovered] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    },
    [onClick],
  );

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={handleKeyDown}
      aria-pressed={active}
      className="font-mono whitespace-nowrap transition-all duration-150"
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1,
        padding: "6px 14px",
        borderRadius: 4,
        cursor: "pointer",
        background: active
          ? "color-mix(in srgb, var(--led-blue) 8%, transparent)"
          : hovered
            ? "color-mix(in srgb, var(--hw-text-dim) 5%, transparent)"
            : "transparent",
        color: active
          ? "var(--led-blue)"
          : hovered
            ? "var(--hw-text-sec)"
            : "var(--hw-text-dim)",
        border: `1px solid ${
          active
            ? "color-mix(in srgb, var(--led-blue) 27%, transparent)"
            : hovered
              ? "var(--hw-border-light)"
              : "transparent"
        }`,
      }}
    >
      {label}
    </button>
  );
}
