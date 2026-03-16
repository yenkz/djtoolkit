/**
 * DJToolKit Design System — Tokens (TypeScript)
 * Ported from djtoolkit-ui/design-system/tokens.js
 * Single source of truth for all design tokens.
 */

// LED color system — Pioneer-accurate with three intensity states
export const LED_COLORS = {
  green: {
    dim: "#6A8A6A",
    mid: "#44CC44",
    on: "#44FF44",
    glow: "0 0 14px #44FF4466",
    glowHot:
      "0 0 20px #44FF4499, 0 0 40px #44FF4433, 0 0 60px #44FF4422",
  },
  red: {
    dim: "#8A6A6A",
    mid: "#CC3333",
    on: "#FF4444",
    glow: "0 0 14px #FF444466",
    glowHot:
      "0 0 20px #FF444499, 0 0 40px #FF444444, 0 0 60px #FF444422",
  },
  blue: {
    dim: "#6A7A8A",
    mid: "#3366CC",
    on: "#4488FF",
    glow: "0 0 14px #4488FF66",
    glowHot:
      "0 0 20px #4488FF99, 0 0 40px #4488FF44, 0 0 60px #4488FF22",
  },
  orange: {
    dim: "#8A7A5A",
    mid: "#CC8833",
    on: "#FFA033",
    glow: "0 0 14px #FFA03366",
    glowHot:
      "0 0 20px #FFA03399, 0 0 40px #FFA03344, 0 0 60px #FFA03322",
  },
} as const;

// Brushed steel gradients
export const STEEL = {
  gradient:
    "linear-gradient(135deg, #6B7B8D 0%, #8E9BAA 25%, #A3B1BF 40%, #7D8FA0 55%, #95A7B5 70%, #6B7B8D 100%)",
  gradientHot:
    "linear-gradient(135deg, #7B8D9F 0%, #A8BBCB 40%, #B8C5D1 60%, #7B8D9F 100%)",
  conic:
    "conic-gradient(from 0deg, #6B7B8D, #8E9BAA, #A3B1BF, #7D8FA0, #95A7B5, #6B7B8D, #8E9BAA, #A3B1BF, #7D8FA0, #6B7B8D)",
} as const;

// CDJ hardware body/surface palette — dark theme
export const HARDWARE = {
  body: "#141114",
  surface: "#1A171A",
  panel: "#1E1B1E",
  raised: "#252225",
  border: "#2A272A",
  borderLight: "#333033",
  groove: "#0E0C0E",
  text: "#EBEED5",
  textSec: "#EBEED5aa",
  textDim: "#EBEED577",
  textMuted: "#EBEED544",
} as const;

// Light palette
export const HARDWARE_LIGHT = {
  body: "#EDEADF",
  surface: "#F5F3EA",
  panel: "#F0EDE5",
  raised: "#E0DDD0",
  border: "#C8C5B5",
  borderLight: "#D5D1C4",
  groove: "#E5E2D6",
  text: "#1A1418",
  textSec: "#1A141899",
  textDim: "#1A141866",
  textMuted: "#1A141844",
} as const;

// Rubber / silicone pad surface
export const RUBBER = {
  base: "#C8C4B8",
  baseDark: "#B8B4A8",
  pad: "#D2CFC4",
  padEdge: "#BAB7AC",
  highlight: "rgba(255,255,255,0.25)",
  shadow: "rgba(0,0,0,0.12)",
} as const;

// Typography
export const FONTS = {
  mono: "'Space Mono', monospace",
  sans: "'DM Sans', sans-serif",
} as const;

// Pad color variants with tint states for translucent pads
export const PAD_COLORS = {
  green: {
    ...LED_COLORS.green,
    tintRest: "rgba(68,255,68,0.04)",
    tintHover: "rgba(68,255,68,0.12)",
    tintPress: "rgba(68,255,68,0.25)",
  },
  red: {
    ...LED_COLORS.red,
    tintRest: "rgba(255,68,68,0.04)",
    tintHover: "rgba(255,68,68,0.12)",
    tintPress: "rgba(255,68,68,0.25)",
  },
  blue: {
    ...LED_COLORS.blue,
    tintRest: "rgba(68,136,255,0.04)",
    tintHover: "rgba(68,136,255,0.12)",
    tintPress: "rgba(68,136,255,0.25)",
  },
  orange: {
    ...LED_COLORS.orange,
    tintRest: "rgba(255,160,51,0.04)",
    tintHover: "rgba(255,160,51,0.12)",
    tintPress: "rgba(255,160,51,0.25)",
  },
} as const;

// Status → LED color mapping
export const STATUS_LED = {
  available: "green",
  candidate: "orange",
  downloading: "blue",
  failed: "red",
  duplicate: "green",
} as const;

// Job status → LED color mapping (pipeline)
export const JOB_STATUS_LED = {
  pending: "orange",
  running: "blue",
  done: "green",
  failed: "red",
} as const;

// Job type → LED color mapping (pipeline)
export const JOB_TYPE_LED = {
  download: "blue",
  fingerprint: "green",
  tag: "orange",
} as const;

export type LEDColor = keyof typeof LED_COLORS;
export type StatusKey = keyof typeof STATUS_LED;
export type JobStatus = keyof typeof JOB_STATUS_LED;
export type JobType = keyof typeof JOB_TYPE_LED;
