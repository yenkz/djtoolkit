"use client";

import { LayoutGrid, List, AlignJustify } from "lucide-react";
import type { LucideIcon } from "lucide-react";

type ViewMode = "grid" | "list" | "compact";

interface ViewToggleProps {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

const modes: { key: ViewMode; Icon: LucideIcon; tip: string }[] = [
  { key: "grid", Icon: LayoutGrid, tip: "Grid" },
  { key: "list", Icon: List, tip: "List" },
  { key: "compact", Icon: AlignJustify, tip: "Compact" },
];

export default function ViewToggle({ mode, onChange }: ViewToggleProps) {
  return (
    <div
      className="flex overflow-hidden"
      style={{
        border: "1px solid var(--hw-border-light)",
        borderRadius: 5,
      }}
    >
      {modes.map((m, i) => {
        const active = mode === m.key;
        return (
          <button
            key={m.key}
            type="button"
            onClick={() => onChange(m.key)}
            title={m.tip}
            aria-label={`${m.tip} view`}
            aria-pressed={active}
            className="flex items-center transition-all duration-150"
            style={{
              padding: "8px 12px",
              cursor: "pointer",
              color: active ? "var(--led-blue)" : "var(--hw-text-muted)",
              background: active
                ? "color-mix(in srgb, var(--led-blue) 5%, transparent)"
                : "transparent",
              boxShadow: active ? "0 0 12px var(--led-blue-glow, rgba(68,136,255,0.33))" : "none",
              border: "none",
              borderRight:
                i < modes.length - 1
                  ? "1px solid var(--hw-border-light)"
                  : "none",
            }}
          >
            <m.Icon size={16} />
          </button>
        );
      })}
    </div>
  );
}
