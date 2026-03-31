"use client";

import { useCallback, type KeyboardEvent } from "react";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}

export default function Toggle({ checked, onChange, disabled = false, "aria-label": ariaLabel }: ToggleProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (disabled) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onChange(!checked);
      }
    },
    [checked, onChange, disabled],
  );

  return (
    <div
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onChange(!checked)}
      onKeyDown={handleKeyDown}
      className="relative cursor-pointer transition-all duration-200"
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        background: checked ? "var(--led-blue)" : "var(--hw-raised)",
        border: `1.5px solid ${checked ? "var(--led-blue)" : "var(--hw-border-light)"}`,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        boxShadow: checked ? "0 0 12px color-mix(in srgb, var(--led-blue) 33%, transparent)" : "none",
      }}
    >
      <div
        className="transition-all duration-200"
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: checked ? "#fff" : "var(--hw-text-muted)",
          position: "absolute",
          top: 2,
          left: checked ? 20 : 2,
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          transitionTimingFunction: "cubic-bezier(.23,1,.32,1)",
        }}
      />
    </div>
  );
}
