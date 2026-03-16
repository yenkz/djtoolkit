"use client";

import { useState } from "react";

interface FilterSelectOption {
  value: string;
  label: string;
}

interface FilterSelectProps {
  options: FilterSelectOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
}

export default function FilterSelect({
  options,
  value,
  onChange,
  label,
}: FilterSelectProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative"
    >
      {label && (
        <label
          className="block font-mono mb-1.5"
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            color: "var(--hw-text-dim)",
          }}
        >
          {label}
        </label>
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono transition-all duration-150"
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: hovered ? "var(--led-blue)" : "var(--hw-text-dim)",
          background: "var(--hw-list-bg)",
          border: `1px solid ${
            hovered
              ? "color-mix(in srgb, var(--led-blue) 27%, transparent)"
              : "var(--hw-list-border)"
          }`,
          borderRadius: 5,
          padding: "7px 28px 7px 12px",
          cursor: "pointer",
          outline: "none",
          appearance: "none",
          WebkitAppearance: "none",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="var(--hw-text-muted)"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="absolute pointer-events-none"
        style={{ right: 10, top: label ? "calc(50% + 10px)" : "50%", transform: "translateY(-50%)" }}
      >
        <path d="M4 6l4 4 4-4" />
      </svg>
    </div>
  );
}
