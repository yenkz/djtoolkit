"use client";

interface LogoProps {
  color?: string;
  w?: number;
  h?: number;
}

export default function Logo({ color = "#EBEED5", w = 28, h = 20 }: LogoProps) {
  return (
    <svg width={w} height={h} viewBox="0 0 60 40" fill="none" style={{ display: "block" }}>
      <path
        d="M2 22c1.5-1 3-3 4.5-5s2.5 1 3.5 4c1.2 3.5 2 6 3.5 3s3-10 4.5-15c1.8-6 2.5-8 4 0s2.5 14 4 18c1.2 3 2 4 3.5-1s3-12 4.5-16c1.3-3.5 2-4 3 0s2 8 3 11c.8 2.2 1.5 3 2.5 0s2-6.5 3-8c.7-1 1.2-.5 2 .5s1.5 2 2.5 2.5c1 .5 2.5.2 4 0s3-.5 4.5-.3"
        style={{ stroke: color }}
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}