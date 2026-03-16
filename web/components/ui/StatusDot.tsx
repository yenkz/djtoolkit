"use client";

interface StatusDotProps {
  status: string;
  size?: number;
  className?: string;
}

const STATUS_COLORS: Record<string, { bg: string; glow: string }> = {
  available: { bg: "var(--led-green)", glow: "0 0 6px rgba(68,255,68,0.27)" },
  candidate: { bg: "var(--led-orange)", glow: "0 0 6px rgba(255,160,51,0.27)" },
  downloading: { bg: "var(--led-blue)", glow: "0 0 6px rgba(68,136,255,0.27)" },
  failed: { bg: "var(--led-red)", glow: "0 0 6px rgba(255,68,68,0.27)" },
  duplicate: { bg: "var(--led-green-dim)", glow: "0 0 6px rgba(106,138,106,0.27)" },
  // Agent statuses
  active: { bg: "#44FF44", glow: "0 0 8px rgba(68,255,68,0.4)" },
  connected: { bg: "#44FF44", glow: "0 0 8px rgba(68,255,68,0.4)" },
  inactive: { bg: "#FF4444", glow: "0 0 8px rgba(255,68,68,0.4)" },
  disconnected: { bg: "#FF4444", glow: "0 0 8px rgba(255,68,68,0.4)" },
  waiting: { bg: "var(--led-orange)", glow: "0 0 8px rgba(255,160,51,0.4)" },
};

const FALLBACK = { bg: "var(--hw-text-muted)", glow: "none" };

export default function StatusDot({ status, size = 7, className }: StatusDotProps) {
  const c = STATUS_COLORS[status] ?? FALLBACK;

  return (
    <span
      role="status"
      aria-label={status}
      className={`inline-block shrink-0 ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: c.bg,
        boxShadow: c.glow,
      }}
    />
  );
}
