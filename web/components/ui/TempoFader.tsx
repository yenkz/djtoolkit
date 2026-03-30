"use client";

import { useCallback, useRef, useState } from "react";
import { HARDWARE, LED_COLORS, STEEL, FONTS } from "@/lib/design-system/tokens";

interface TempoFaderProps {
  label?: string;
  initial?: number;
  min?: number;
  max?: number;
  unit?: string;
  onChange?: (value: number) => void;
}

export default function TempoFader({
  label = "TEMPO",
  initial = 128,
  min = 70,
  max = 180,
  unit = "BPM",
  onChange,
}: TempoFaderProps) {
  const [value, setValue] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);

  const pct = (value - min) / (max - min);

  const updateFromY = useCallback(
    (clientY: number) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      // Inverted: top = max, bottom = min
      const ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const newValue = Math.round(min + ratio * (max - min));
      setValue(newValue);
      onChange?.(newValue);
    },
    [min, max, onChange],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      setDragging(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      updateFromY(e.clientY);
    },
    [updateFromY],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      updateFromY(e.clientY);
    },
    [dragging, updateFromY],
  );

  const handlePointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  // Reset to initial on double-click
  const handleDoubleClick = useCallback(() => {
    setValue(initial);
    onChange?.(initial);
  }, [initial, onChange]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        userSelect: "none",
      }}
    >
      {/* Label */}
      <span
        style={{
          fontFamily: FONTS.mono,
          fontSize: 10,
          letterSpacing: "0.08em",
          color: HARDWARE.textDim,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>

      {/* Fader track */}
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        style={{
          position: "relative",
          width: 32,
          height: 120,
          background: HARDWARE.groove,
          borderRadius: 4,
          border: `1px solid ${HARDWARE.border}`,
          boxShadow: "inset 0 1px 4px rgba(0,0,0,0.5)",
          cursor: dragging ? "grabbing" : "pointer",
          touchAction: "none",
        }}
      >
        {/* Center line */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 8,
            bottom: 8,
            width: 2,
            transform: "translateX(-50%)",
            background: HARDWARE.border,
            borderRadius: 1,
          }}
        />

        {/* Active fill */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 8,
            width: 2,
            height: `${pct * (120 - 16)}px`,
            transform: "translateX(-50%)",
            background: LED_COLORS.green.dim,
            borderRadius: 1,
            transition: dragging ? "none" : "height 0.1s",
          }}
        />

        {/* Knob */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: `${pct * (120 - 16) + 8}px`,
            transform: "translate(-50%, 50%)",
            width: 28,
            height: 14,
            borderRadius: 3,
            background: dragging ? STEEL.gradientHot : STEEL.gradient,
            border: `1px solid ${HARDWARE.borderLight}`,
            boxShadow: dragging
              ? `0 0 10px rgba(0,0,0,0.4), ${LED_COLORS.green.glow}`
              : "0 1px 4px rgba(0,0,0,0.4)",
            transition: dragging
              ? "background 0.15s"
              : "background 0.15s, bottom 0.1s",
          }}
        >
          {/* Knob grip lines */}
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              display: "flex",
              gap: 2,
            }}
          >
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  width: 1,
                  height: 6,
                  background: "rgba(0,0,0,0.3)",
                  borderRadius: 0.5,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Value display */}
      <span
        style={{
          fontFamily: FONTS.mono,
          fontSize: 13,
          color: HARDWARE.text,
          letterSpacing: "0.04em",
        }}
      >
        {value}{" "}
        <span style={{ fontSize: 9, color: HARDWARE.textDim }}>{unit}</span>
      </span>
    </div>
  );
}
