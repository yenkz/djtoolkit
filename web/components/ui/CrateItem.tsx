"use client";

import { useState } from "react";

interface CrateItemProps {
  name: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

export default function CrateItem({ name, count, active, onClick }: CrateItemProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="flex items-center justify-between cursor-pointer transition-all duration-150"
      style={{
        padding: "9px 14px",
        borderRadius: 5,
        borderLeft: active
          ? "3px solid var(--led-blue)"
          : "3px solid transparent",
        background: active
          ? "color-mix(in srgb, var(--led-blue) 5%, transparent)"
          : hovered
            ? "color-mix(in srgb, var(--hw-text-dim) 5%, transparent)"
            : "transparent",
      }}
    >
      <span
        className="font-sans"
        style={{
          fontSize: 13,
          fontWeight: active ? 700 : 500,
          color: active
            ? "var(--led-blue)"
            : hovered
              ? "var(--hw-text)"
              : "var(--hw-text-sec)",
        }}
      >
        {name}
      </span>
      <span
        className="font-mono"
        style={{ fontSize: 10, color: "var(--hw-text-muted)" }}
      >
        {count}
      </span>
    </div>
  );
}
