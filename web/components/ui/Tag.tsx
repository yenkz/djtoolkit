"use client";

interface TagProps {
  label: string;
}

export default function Tag({ label }: TagProps) {
  return (
    <span
      className="font-mono text-hw-text-dim bg-hw-tag-bg border border-hw-tag-border"
      style={{
        fontSize: 9,
        letterSpacing: 0.5,
        padding: "2px 8px",
        borderRadius: 3,
      }}
    >
      {label}
    </span>
  );
}
