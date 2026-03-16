"use client";

import { useState } from "react";
import { Search } from "lucide-react";

interface MiniSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function MiniSearch({
  value,
  onChange,
  placeholder = "Search...",
}: MiniSearchProps) {
  const [focused, setFocused] = useState(false);

  return (
    <div className="relative flex items-center">
      <Search
        size={16}
        className="absolute left-3 pointer-events-none transition-colors duration-200"
        style={{
          color: focused ? "var(--led-blue)" : "var(--hw-text-muted)",
        }}
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="w-full font-sans text-sm transition-all duration-200"
        style={{
          color: "var(--hw-text)",
          background: focused ? "var(--hw-input-focus)" : "var(--hw-input-bg)",
          border: `1.5px solid ${
            focused
              ? "color-mix(in srgb, var(--led-blue) 27%, transparent)"
              : "var(--hw-input-border)"
          }`,
          borderRadius: 6,
          padding: "12px 16px 12px 36px",
          outline: "none",
          boxShadow: focused
            ? "0 0 0 3px color-mix(in srgb, var(--led-blue) 7%, transparent)"
            : "none",
        }}
      />
    </div>
  );
}
