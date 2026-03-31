"use client";

import { useState, useEffect, type ReactNode } from "react";
import { RUBBER, FONTS, HARDWARE } from "@/lib/design-system/tokens";

interface PadHousingProps {
  children: ReactNode;
  cols?: number;
  mobileCols?: number;
  gap?: number;
  label?: string;
}

export default function PadHousing({
  children,
  cols = 4,
  mobileCols,
  gap = 5,
  label,
}: PadHousingProps) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const actualCols = isMobile && mobileCols ? mobileCols : cols;

  return (
    <div>
      {label && (
        <div
          style={{
            fontFamily: FONTS.mono,
            fontSize: 8,
            color: "var(--hw-text-dim)",
            letterSpacing: 2,
            textTransform: "uppercase",
            marginBottom: 10,
          }}
        >
          {label}
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${actualCols}, 1fr)`,
          gap,
          background: RUBBER.base,
          padding: 7,
          border: `1px solid ${RUBBER.padEdge}`,
          borderRadius: 6,
          boxShadow: `inset 0 1px 0 ${RUBBER.highlight}, inset 0 -2px 4px rgba(0,0,0,0.06), 0 2px 8px rgba(0,0,0,0.15)`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
