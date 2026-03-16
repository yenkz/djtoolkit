"use client";

import { useEffect, useRef, useState } from "react";
import Logo from "@/components/ui/Logo";
import { HARDWARE, LED_COLORS } from "@/lib/design-system/tokens";

export default function JogWheel() {
  const [rot, setRot] = useState(0);
  const [touched, setTouched] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(180);

  useEffect(() => {
    const check = () => {
      if (containerRef.current) {
        const w = containerRef.current.offsetWidth;
        setSize(Math.min(w, 260));
      }
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    const iv = setInterval(
      () => setRot((r) => r + (touched ? 0.1 : 0.4)),
      16,
    );
    return () => clearInterval(iv);
  }, [touched]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        maxWidth: 260,
        aspectRatio: "1/1",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onMouseDown={() => setTouched(true)}
        onMouseUp={() => setTouched(false)}
        onMouseLeave={() => setTouched(false)}
        onTouchStart={() => setTouched(true)}
        onTouchEnd={() => setTouched(false)}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: `radial-gradient(circle at 45% 40%, ${HARDWARE.raised} 0%, ${HARDWARE.groove} 100%)`,
          border: `3px solid ${HARDWARE.borderLight}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: `inset 0 2px 8px rgba(0,0,0,0.5), 0 0 ${touched ? 30 : 20}px rgba(0,0,0,0.3)`,
          position: "relative",
          cursor: touched ? "grabbing" : "grab",
          transition: "box-shadow 0.3s",
        }}
      >
        {/* Tick marks */}
        {Array.from({ length: 36 }, (_, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              width: 2,
              height: i % 9 === 0 ? size * 0.045 : size * 0.027,
              background:
                i % 9 === 0
                  ? `${HARDWARE.text}44`
                  : `${HARDWARE.text}15`,
              top: size * 0.036,
              left: "50%",
              transformOrigin: `50% ${size * 0.464}px`,
              transform: `translateX(-50%) rotate(${i * 10}deg)`,
            }}
          />
        ))}

        {/* Center disc with rotating logo */}
        <div
          style={{
            width: size * 0.45,
            height: size * 0.45,
            borderRadius: "50%",
            background: HARDWARE.body,
            border: `2px solid ${HARDWARE.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transform: `rotate(${rot}deg)`,
          }}
        >
          <Logo
            color={touched ? LED_COLORS.green.on : LED_COLORS.green.dim}
            w={size * 0.16}
            h={size * 0.11}
          />
        </div>

        {/* Position indicator line */}
        <div
          style={{
            position: "absolute",
            top: size * 0.064,
            left: "50%",
            width: 3,
            height: size * 0.064,
            background: touched
              ? LED_COLORS.green.on
              : LED_COLORS.green.dim,
            transform: `translateX(-50%) rotate(${rot}deg)`,
            transformOrigin: `50% ${size * 0.436}px`,
            boxShadow: touched ? LED_COLORS.green.glow : "none",
            borderRadius: 1,
            transition: "background 0.3s, box-shadow 0.3s",
          }}
        />
      </div>
    </div>
  );
}
