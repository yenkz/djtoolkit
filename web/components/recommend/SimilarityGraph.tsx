"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import { usePreviewPlayer } from "@/lib/preview-player-context";
import { useTheme } from "@/lib/theme-provider";
import type { Track, SimilarityEdge } from "@/lib/api";

interface SimilarityGraphProps {
  tracks: Track[];
  edges: SimilarityEdge[];
  seedIds: Set<number>;
  onLike: (trackId: number) => void;
  onDislike: (trackId: number) => void;
}

interface GraphNode {
  id: number;
  name: string;
  artist: string;
  bpm: number;
  camelot: string;
  energy: number;
  genres: string;
  isSeed: boolean;
  val: number;
  color: string;
  x?: number;
  y?: number;
}

interface GraphLink {
  source: number;
  target: number;
  weight: number;
  harmonic: number;
  genre: number;
  feature: number;
}

// Camelot wheel → hue mapping (12 positions around a color wheel)
const CAMELOT_HUE: Record<number, number> = {
  1: 0, 2: 30, 3: 60, 4: 90, 5: 120, 6: 150,
  7: 180, 8: 210, 9: 240, 10: 270, 11: 300, 12: 330,
};

function camelotToColor(camelot: string, energy: number): string {
  if (!camelot || camelot.length < 2) return `hsl(210, 30%, ${35 + energy * 25}%)`;
  const num = parseInt(camelot.slice(0, -1), 10);
  const letter = camelot.slice(-1);
  const hue = CAMELOT_HUE[num] ?? 210;
  // A keys (minor) are slightly desaturated, B keys (major) more vivid
  const sat = letter === "A" ? 55 : 70;
  const light = 35 + energy * 25; // brighter = more energy
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

type ColorMode = "key" | "energy" | "genre";

// Energy mode colors — used for canvas (can't use CSS vars)
const ENERGY_COLORS = {
  dark: { low: "#44FF44", mid: "#FFA033", high: "#FF4444" },
  light: { low: "#0A6A33", mid: "#885000", high: "#AA2222" },
};

// Assign a stable color per genre
function genreToColor(genre: string): string {
  let hash = 0;
  for (let i = 0; i < genre.length; i++) hash = genre.charCodeAt(i) + ((hash << 5) - hash);
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 60%, 50%)`;
}

export default function SimilarityGraph({ tracks, edges, seedIds, onLike, onDislike }: SimilarityGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [ForceGraph, setForceGraph] = useState<any>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("key");
  const [showHarmonicOnly, setShowHarmonicOnly] = useState(false);
  const { play, pause, currentTrackId, isPlaying } = usePreviewPlayer();
  const { resolved: theme } = useTheme();

  void onLike;
  void onDislike;

  const isLight = theme === "light";
  const textDimColor = isLight ? "#1A1418a8" : "#EBEED599";
  const grooveColor = isLight ? "#E5E2D6" : "#0E0C0E";
  const surfaceColor = isLight ? "#F5F3EA" : "#1A171A";
  const borderColor = isLight ? "#C8C5B5" : "#2A272A";
  const seedRingColor = isLight ? "#1A1418" : "#fff";
  const labelColor = isLight ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.9)";
  const overlayBg = isLight ? "rgba(240,237,229,0.92)" : "rgba(10,10,20,0.85)";
  const activeControlBg = isLight ? "rgba(26,85,170,0.6)" : "rgba(68,136,255,0.6)";
  const harmonicActiveBg = isLight ? "rgba(10,106,51,0.4)" : "rgba(68,255,68,0.4)";

  const [dimensions, setDimensions] = useState({ width: 700, height: 400 });

  useEffect(() => {
    import("react-force-graph-2d").then(mod => setForceGraph(() => mod.default));
  }, []);

  // Track container size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setDimensions({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Configure d3 forces after graph mounts
  useEffect(() => {
    if (!graphRef.current) return;
    const fg = graphRef.current;
    // Strong repulsion so nodes spread out
    fg.d3Force("charge")?.strength(-200).distanceMax(300);
    // Link distance inversely proportional to weight (similar = closer)
    fg.d3Force("link")?.distance((link: GraphLink) => {
      return 30 + (1 - (link.weight ?? 0.5)) * 150;
    }).strength((link: GraphLink) => {
      // Harmonic links pull harder
      return link.harmonic >= 0.8 ? 0.3 : 0.05;
    });
    // Gentle centering
    fg.d3Force("center")?.strength(0.05);
    fg.d3ReheatSimulation();
  }, [ForceGraph, edges.length, showHarmonicOnly]);

  const getNodeColor = useCallback((t: Track): string => {
    if (colorMode === "key") return camelotToColor(t.key_normalized ?? "", t.energy ?? 0.5);
    if (colorMode === "energy") {
      const e = t.energy ?? 0.5;
      const palette = isLight ? ENERGY_COLORS.light : ENERGY_COLORS.dark;
      if (e > 0.75) return palette.high;
      if (e > 0.5) return palette.mid;
      return palette.low;
    }
    // genre
    const first = (t.genres ?? "").split(",")[0]?.trim().toLowerCase();
    return first ? genreToColor(first) : textDimColor;
  }, [colorMode, isLight, textDimColor]);

  const nodes: GraphNode[] = tracks.map(t => ({
    id: t.id,
    name: t.title,
    artist: t.artist,
    bpm: Math.round(t.tempo ?? 0),
    camelot: t.key_normalized ?? "",
    energy: t.energy ?? 0,
    genres: t.genres ?? "",
    isSeed: seedIds.has(t.id),
    // Size by energy (bigger = more energy), seeds are always prominent
    val: seedIds.has(t.id) ? 3 : 1.2 + (t.energy ?? 0.5) * 1.8,
    color: getNodeColor(t),
  }));

  const links: GraphLink[] = (showHarmonicOnly
    ? edges.filter(e => e.harmonic >= 0.8)
    : edges
  ).map(e => ({
    source: e.source,
    target: e.target,
    weight: e.weight,
    harmonic: e.harmonic,
    genre: e.genre,
    feature: e.feature,
  }));

  const handleNodeClick = useCallback((node: GraphNode) => {
    const track = tracks.find(t => t.id === node.id);
    if (!track) return;
    if (currentTrackId === track.id && isPlaying) {
      pause();
    } else if (track.spotify_uri) {
      play(track.id, track.spotify_uri);
    }
  }, [tracks, currentTrackId, isPlaying, play, pause]);

  const nodeCanvasObject = useCallback((node: GraphNode, ctx: CanvasRenderingContext2D) => {
    const size = (node.val ?? 1) * 5;
    const x = node.x ?? 0;
    const y = node.y ?? 0;

    // Seed glow
    if (node.isSeed) {
      ctx.beginPath();
      ctx.arc(x, y, size + 5, 0, 2 * Math.PI);
      ctx.fillStyle = isLight ? "rgba(0, 0, 0, 0.08)" : "rgba(255, 255, 255, 0.15)";
      ctx.fill();
    }

    // Main circle
    ctx.beginPath();
    ctx.arc(x, y, size, 0, 2 * Math.PI);
    ctx.fillStyle = node.color;
    ctx.fill();

    // Seed ring
    if (node.isSeed) {
      ctx.strokeStyle = seedRingColor;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Camelot label for larger nodes
    if (node.camelot && size > 7) {
      ctx.font = `${Math.max(7, size * 0.7)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = labelColor;
      ctx.fillText(node.camelot, x, y);
    }
  }, [isLight, seedRingColor, labelColor]);

  const linkColorFn = useCallback((link: GraphLink) => {
    // Harmonic links glow green, genre links glow blue, otherwise dim
    if (link.harmonic >= 0.8) return isLight ? "rgba(10, 106, 51, 0.4)" : "rgba(68, 255, 68, 0.35)";
    if (link.genre >= 0.5) return isLight ? "rgba(26, 85, 170, 0.3)" : "rgba(68, 136, 255, 0.25)";
    return isLight ? "rgba(0, 0, 0, 0.08)" : "rgba(255, 255, 255, 0.06)";
  }, [isLight]);

  if (!ForceGraph) {
    return (
      <div style={{
        width: "100%", height: "40vh", minHeight: 280, maxHeight: 600,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: 16,
        background: grooveColor, borderRadius: 8,
      }}>
        <div style={{ position: "relative", width: 80, height: 80 }}>
          <svg width="80" height="80" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="30" fill="none" stroke={borderColor} strokeWidth="1" />
            <circle cx="40" cy="40" r="18" fill="none" stroke={borderColor} strokeWidth="1" opacity="0.5" />
            <circle r="4" fill="var(--led-blue)">
              <animateMotion dur="3s" repeatCount="indefinite" path="M40,10 A30,30 0 1,1 39.99,10" />
            </circle>
            <circle r="3" fill="var(--led-green)" opacity="0.8">
              <animateMotion dur="2s" repeatCount="indefinite" path="M40,22 A18,18 0 1,1 39.99,22" />
            </circle>
            <circle r="2.5" fill="var(--led-orange)" opacity="0.7">
              <animateMotion dur="4s" repeatCount="indefinite" path="M40,10 A30,30 0 1,0 39.99,10" />
            </circle>
            <circle cx="40" cy="40" r="5" fill={surfaceColor} stroke="var(--led-blue-mid)" strokeWidth="1.5" />
          </svg>
        </div>
        <span style={{ color: textDimColor, fontSize: 13 }}>Building similarity graph...</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", height: "40vh", minHeight: 280, maxHeight: 600 }}>
      {/* Controls overlay */}
      <div style={{
        position: "absolute", top: 8, right: 8, zIndex: 10,
        display: "flex", gap: 4,
      }}>
        {(["key", "energy", "genre"] as const).map(mode => (
          <button key={mode} onClick={() => setColorMode(mode)} style={{
            background: colorMode === mode ? activeControlBg : overlayBg,
            padding: "4px 10px", borderRadius: 6,
            fontSize: 10, color: isLight ? (colorMode === mode ? "#fff" : "#1A1418") : "#fff",
            border: "none", cursor: "pointer",
            textTransform: "capitalize",
          }}>
            {mode}
          </button>
        ))}
        <button onClick={() => setShowHarmonicOnly(!showHarmonicOnly)} style={{
          background: showHarmonicOnly ? harmonicActiveBg : overlayBg,
          padding: "4px 10px", borderRadius: 6,
          fontSize: 10, color: isLight ? (showHarmonicOnly ? "#fff" : "#1A1418") : "#fff",
          border: "none", cursor: "pointer",
        }}>
          {showHarmonicOnly ? "Harmonic" : "All edges"}
        </button>
      </div>

      {/* Legend */}
      <div style={{
        position: "absolute", bottom: 8, left: 8, zIndex: 10,
        background: overlayBg, padding: "6px 10px", borderRadius: 6,
        fontSize: 9, color: textDimColor, display: "flex", gap: 12,
      }}>
        {colorMode === "key" && (
          <>
            <span>Node color = Camelot key</span>
            <span>Size = energy</span>
            <span style={{ color: isLight ? "rgba(10,106,51,0.9)" : "rgba(68,255,68,0.8)" }}>Green edge = harmonic match</span>
          </>
        )}
        {colorMode === "energy" && (
          <>
            <span style={{ color: "var(--led-green)" }}>Low</span>
            <span style={{ color: "var(--led-orange)" }}>Mid</span>
            <span style={{ color: "var(--led-red)" }}>High</span>
            <span>Size = energy</span>
          </>
        )}
        {colorMode === "genre" && (
          <>
            <span>Node color = primary genre</span>
            <span>Size = energy</span>
            <span style={{ color: isLight ? "rgba(26,85,170,0.9)" : "rgba(68,136,255,0.8)" }}>Blue edge = genre match</span>
          </>
        )}
        <span style={{ color: isLight ? "#1A1418" : "#fff" }}>
          {isLight ? "Dark" : "White"} ring = seed
        </span>
      </div>

      <ForceGraph
        ref={graphRef}
        graphData={{ nodes, links }}
        nodeCanvasObject={nodeCanvasObject}
        linkColor={linkColorFn}
        linkWidth={(link: GraphLink) => {
          if (link.harmonic >= 0.8) return 2;
          if (link.genre >= 0.5) return 1.5;
          return 0.5;
        }}
        onNodeClick={handleNodeClick}
        nodeLabel={(node: GraphNode) =>
          `${node.artist} \u2014 ${node.name}\n${node.bpm} BPM \u00b7 ${node.camelot} \u00b7 E ${node.energy.toFixed(2)}\n${node.genres.split(",").slice(0, 3).join(", ")}`
        }
        width={dimensions.width}
        height={dimensions.height}
        backgroundColor={grooveColor}
        cooldownTime={5000}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        linkDirectionalParticles={(link: GraphLink) => link.harmonic >= 0.8 ? 2 : 0}
        linkDirectionalParticleWidth={2}
        linkDirectionalParticleColor={() => isLight ? "rgba(10,106,51,0.7)" : "rgba(68,255,68,0.6)"}
      />
    </div>
  );
}
