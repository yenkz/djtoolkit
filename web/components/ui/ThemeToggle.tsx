"use client";

import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "@/lib/theme-provider";

const MODES = [
  { value: "light" as const, icon: Sun, label: "Light" },
  { value: "system" as const, icon: Monitor, label: "System" },
  { value: "dark" as const, icon: Moon, label: "Dark" },
];

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex items-center gap-1">
      {MODES.map(({ value, icon: Icon, label }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-label={`${label} theme`}
            className="flex items-center justify-center rounded transition-colors duration-200"
            style={{
              width: 28,
              height: 28,
              color: active ? "var(--led-blue)" : "var(--hw-text-dim)",
              background: active ? "color-mix(in srgb, var(--led-blue) 12%, transparent)" : "transparent",
              boxShadow: active ? "0 0 8px color-mix(in srgb, var(--led-blue) 25%, transparent)" : "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            <Icon size={14} strokeWidth={2} />
          </button>
        );
      })}
    </div>
  );
}
