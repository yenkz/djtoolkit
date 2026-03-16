"use client";

import { useState } from "react";

interface TextInputProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
  desc?: string;
  type?: string;
  placeholder?: string;
}

export default function TextInput({
  label,
  value,
  onChange,
  mono = false,
  desc,
  type = "text",
  placeholder,
}: TextInputProps) {
  const [focused, setFocused] = useState(false);

  return (
    <div className="flex flex-col" style={{ gap: label ? 6 : 0 }}>
      {label && (
        <div className="flex items-center gap-2">
          <div
            className="transition-all duration-300"
            style={{
              width: 4,
              height: 4,
              borderRadius: "50%",
              background: focused ? "var(--led-blue)" : "var(--hw-text-muted)",
              boxShadow: focused
                ? "0 0 6px color-mix(in srgb, var(--led-blue) 40%, transparent)"
                : "none",
            }}
          />
          <label
            className="font-mono transition-colors duration-300"
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: focused ? "var(--led-blue)" : "var(--hw-text-dim)",
              textShadow: focused
                ? "0 0 14px color-mix(in srgb, var(--led-blue) 40%, transparent)"
                : "none",
            }}
          >
            {label}
          </label>
        </div>
      )}
      {desc && (
        <p
          className="font-sans"
          style={{
            fontSize: 12,
            color: "var(--hw-text-dim)",
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          {desc}
        </p>
      )}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`w-full transition-all duration-200 ${mono ? "font-mono" : "font-sans"}`}
        style={{
          fontSize: 13,
          color: "var(--hw-text)",
          background: focused ? "var(--hw-input-focus)" : "var(--hw-input-bg)",
          border: `1.5px solid ${
            focused
              ? "color-mix(in srgb, var(--led-blue) 27%, transparent)"
              : "var(--hw-input-border)"
          }`,
          borderRadius: 5,
          padding: "10px 14px",
          outline: "none",
          boxShadow: focused
            ? "0 0 0 3px color-mix(in srgb, var(--led-blue) 7%, transparent)"
            : "none",
        }}
      />
    </div>
  );
}
