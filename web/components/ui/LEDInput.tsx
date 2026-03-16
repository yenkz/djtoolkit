"use client";

import { useState, type InputHTMLAttributes } from "react";
import { LED_COLORS, HARDWARE, FONTS } from "@/lib/design-system/tokens";

interface LEDInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export default function LEDInput({ label, ...props }: LEDInputProps) {
  const [focused, setFocused] = useState(false);
  const c = LED_COLORS.blue;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {label && (
        <label
          style={{
            fontFamily: FONTS.mono,
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 2,
            textTransform: "uppercase",
            color: focused ? c.on : HARDWARE.textDim,
            textShadow: focused ? c.glow : "none",
            transition: "all 0.3s",
          }}
        >
          {label}
        </label>
      )}
      <input
        {...props}
        onFocus={(e) => {
          setFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          props.onBlur?.(e);
        }}
        style={{
          background: HARDWARE.groove,
          border: `1.5px solid ${focused ? c.on : HARDWARE.border}`,
          borderRadius: 0,
          padding: "10px 14px",
          color: HARDWARE.text,
          fontFamily: FONTS.sans,
          fontSize: 14,
          outline: "none",
          boxShadow: focused
            ? `0 0 12px ${c.on}33, inset 0 0 8px ${c.on}11`
            : "none",
          transition: "all 0.25s",
          ...props.style,
        }}
      />
    </div>
  );
}
