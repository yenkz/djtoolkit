"use client";

import { useCallback, type KeyboardEvent } from "react";

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}

export default function Checkbox({ checked, onChange, label }: CheckboxProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onChange(!checked);
      }
    },
    [checked, onChange],
  );

  const box = (
    <div
      role="checkbox"
      aria-checked={checked}
      aria-label={label || undefined}
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      onKeyDown={handleKeyDown}
      className="flex items-center justify-center cursor-pointer transition-all duration-150"
      style={{
        width: 18,
        height: 18,
        borderRadius: 4,
        background: checked ? "var(--led-blue)" : "transparent",
        border: `2px solid ${checked ? "var(--led-blue)" : "var(--hw-border-light)"}`,
        boxShadow: checked
          ? "0 0 8px color-mix(in srgb, var(--led-blue) 20%, transparent)"
          : "none",
        flexShrink: 0,
      }}
    >
      {checked && (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </div>
  );

  if (!label) return box;

  return (
    <label
      className="flex items-center gap-2.5 cursor-pointer font-sans text-sm"
      style={{ color: "var(--hw-text)" }}
      onClick={(e) => e.preventDefault()}
    >
      {box}
      <span
        onClick={() => onChange(!checked)}
        className="select-none"
      >
        {label}
      </span>
    </label>
  );
}
