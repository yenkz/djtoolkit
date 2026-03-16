"use client";

import { type ReactNode } from "react";

interface SectionProps {
  id: string;
  title: string;
  desc?: string;
  children: ReactNode;
}

export default function Section({ id, title, desc, children }: SectionProps) {
  return (
    <div id={id} className="mb-9" style={{ scrollMarginTop: 20 }}>
      <h3
        className="font-mono uppercase"
        style={{
          fontSize: 18,
          fontWeight: 800,
          color: "var(--hw-text)",
          letterSpacing: -0.3,
          marginBottom: 4,
        }}
      >
        {title}
      </h3>
      {desc && (
        <p
          className="font-sans"
          style={{
            fontSize: 13,
            color: "var(--hw-text-dim)",
            marginBottom: 16,
            lineHeight: 1.5,
          }}
        >
          {desc}
        </p>
      )}
      <div
        className="rounded-lg"
        style={{
          background: "var(--hw-card-bg)",
          border: "1.5px solid var(--hw-card-border)",
          padding: "20px 24px",
        }}
      >
        {children}
      </div>
    </div>
  );
}
