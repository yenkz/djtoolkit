"use client";

interface LCDDisplayProps {
  value: string | number;
  label: string;
  onClick?: () => void;
  active?: boolean;
}

export default function LCDDisplay({ value, label, onClick, active }: LCDDisplayProps) {
  return (
    <div
      className="text-center"
      onClick={onClick}
      style={{
        background: "var(--hw-lcd-bg)",
        border: active
          ? "1.5px solid var(--led-orange)"
          : "1.5px solid var(--hw-lcd-border)",
        borderRadius: 6,
        padding: "16px 18px",
        boxShadow: active
          ? "inset 0 1px 4px rgba(0,0,0,0.4), 0 0 8px rgba(255,160,51,0.2)"
          : "inset 0 1px 4px rgba(0,0,0,0.4)",
        cursor: onClick ? "pointer" : undefined,
        transition: "border-color 0.2s, box-shadow 0.2s",
      }}
    >
      <div
        className="font-mono"
        style={{
          fontSize: "clamp(26px, 4vw, 36px)",
          fontWeight: 900,
          color: "var(--hw-lcd-text)",
          textShadow: "var(--hw-lcd-glow)",
          letterSpacing: -1,
        }}
      >
        {value}
      </div>
      <div
        className="font-mono uppercase"
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: "var(--hw-lcd-dim)",
          letterSpacing: 1,
          marginTop: 6,
        }}
      >
        {label}
      </div>
    </div>
  );
}
