"use client";

import { useState, useEffect, useRef } from "react";

interface SaveBtnProps {
  onClick: () => void;
  saving?: boolean;
  saved?: boolean;
  disabled?: boolean;
}

export default function SaveBtn({
  onClick,
  saving = false,
  saved = false,
  disabled = false,
}: SaveBtnProps) {
  const [hover, setHover] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Show "SAVED" with checkmark for 2s after saved prop becomes true */
  useEffect(() => {
    if (saved) {
      setShowSaved(true);
      timerRef.current = setTimeout(() => setShowSaved(false), 2000);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [saved]);

  const isBusy = saving || showSaved;

  let label: React.ReactNode = "SAVE CHANGES";
  let bg = hover ? "color-mix(in srgb, var(--led-blue) 93%, transparent)" : "var(--led-blue)";

  if (saving) {
    label = (
      <span className="inline-flex items-center gap-2">
        <svg
          className="animate-spin"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <path d="M21 12a9 9 0 11-6.219-8.56" />
        </svg>
        SAVING...
      </span>
    );
    bg = "var(--led-blue)";
  } else if (showSaved) {
    label = (
      <span className="inline-flex items-center gap-1">
        &#10003; SAVED
      </span>
    );
    bg = "var(--led-green)";
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isBusy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="font-mono cursor-pointer transition-all duration-150"
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1.5,
        textTransform: "uppercase",
        padding: "10px 24px",
        borderRadius: 5,
        background: bg,
        color: "#fff",
        border: "none",
        boxShadow: "0 2px 8px color-mix(in srgb, var(--led-blue) 25%, transparent)",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled || isBusy ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}
