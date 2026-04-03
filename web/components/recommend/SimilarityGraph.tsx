"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import { usePreviewPlayer } from "@/lib/preview-player-context";
import type { Track, SimilarityEdge } from "@/lib/api";
import { HARDWARE, LED_COLORS } from "@/lib/design-system/tokens";

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
  const [ForceGraph, setForceGraph] = useState<any>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("key");
  const [showHarmonicOnly, setShowHarmonicOnly] = useState(false);
  const { play, pause, currentTrackId, isPlaying } = usePreviewPlayer();

  void onLike;
  void onDislike;

  useEffect(() => {
    import("react-force-graph-2d").then(mod => setForceGraph(() => mod.default));
  }, []);

  const getNodeColor = useCallback((t: Track): string => {
    if (colorMode === "key") return camelotToColor(t.key_normalized ?? "", t.energy ?? 0.5);
    if (colorMode === "energy") {
      const e = t.energy ?? 0.5;
      if (e > 0.75) return LED_COLORS.red.on;
      if (e > 0.5) return LED_COLORS.orange.on;
      return LED_COLORS.green.on;
    }
    // genre
    const first = (t.genres ?? "").split(",")[0]?.trim().toLowerCase();
    return first ? genreToColor(first) : HARDWARE.textDim;
  }, [colorMode]);

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
      ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
      ctx.fill();
    }

    // Main circle
    ctx.beginPath();
    ctx.arc(x, y, size, 0, 2 * Math.PI);
    ctx.fillStyle = node.color;
    ctx.fill();

    // Seed ring
    if (node.isSeed) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Camelot label for larger nodes
    if (node.camelot && size > 7) {
      ctx.font = `${Math.max(7, size * 0.7)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText(node.camelot, x, y);
    }
  }, []);

  const linkColorFn = useCallback((link: GraphLink) => {
    // Harmonic links glow green, genre links glow blue, otherwise dim
    if (link.harmonic >= 0.8) return "rgba(68, 255, 68, 0.35)";
    if (link.genre >= 0.5) return "rgba(68, 136, 255, 0.25)";
    return "rgba(255, 255, 255, 0.06)";
  }, []);

  if (!ForceGraph) {
    return (
      <div style={{
        width: "100%", height: 500, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: 16,
        background: HARDWARE.groove, borderRadius: 8,
      }}>
        <div style={{ position: "relative", width: 80, height: 80 }}>
          <svg width="80" height="80" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="30" fill="none" stroke={HARDWARE.border} strokeWidth="1" />
            <circle cx="40" cy="40" r="18" fill="none" stroke={HARDWARE.border} strokeWidth="1" opacity="0.5" />
            <circle r="4" fill={LED_COLORS.blue.on}>
              <animateMotion dur="3s" repeatCount="indefinite" path="M40,10 A30,30 0 1,1 39.99,10" />
            </circle>
            <circle r="3" fill={LED_COLORS.green.on} opacity="0.8">
              <animateMotion dur="2s" repeatCount="indefinite" path="M40,22 A18,18 0 1,1 39.99,22" />
            </circle>
            <circle r="2.5" fill={LED_COLORS.orange.on} opacity="0.7">
              <animateMotion dur="4s" repeatCount="indefinite" path="M40,10 A30,30 0 1,0 39.99,10" />
            </circle>
            <circle cx="40" cy="40" r="5" fill={HARDWARE.surface} stroke={LED_COLORS.blue.mid} strokeWidth="1.5" />
          </svg>
        </div>
        <span style={{ color: HARDWARE.textDim, fontSize: 13 }}>Building similarity graph...</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", height: 500 }}>
      {/* Controls overlay */}
      <div style={{
        position: "absolute", top: 8, right: 8, zIndex: 10,
        display: "flex", gap: 4,
      }}>
        {(["key", "energy", "genre"] as const).map(mode => (
          <button key={mode} onClick={() => setColorMode(mode)} style={{
            background: colorMode === mode ? "rgba(68,136,255,0.6)" : "rgba(10,10,20,0.85)",
            padding: "4px 10px", borderRadius: 6,
            fontSize: 10, color: "#fff", border: "none", cursor: "pointer",
            textTransform: "capitalize",
          }}>
            {mode}
          </button>
        ))}
        <button onClick={() => setShowHarmonicOnly(!showHarmonicOnly)} style={{
          background: showHarmonicOnly ? "rgba(68,255,68,0.4)" : "rgba(10,10,20,0.85)",
          padding: "4px 10px", borderRadius: 6,
          fontSize: 10, color: "#fff", border: "none", cursor: "pointer",
        }}>
          {showHarmonicOnly ? "Harmonic" : "All edges"}
        </button>
      </div>

      {/* Legend */}
      <div style={{
        position: "absolute", bottom: 8, left: 8, zIndex: 10,
        background: "rgba(10,10,20,0.85)", padding: "6px 10px", borderRadius: 6,
        fontSize: 9, color: HARDWARE.textDim, display: "flex", gap: 12,
      }}>
        {colorMode === "key" && (
          <>
            <span>Node color = Camelot key</span>
            <span>Size = energy</span>
            <span style={{ color: "rgba(68,255,68,0.8)" }}>Green edge = harmonic match</span>
          </>
        )}
        {colorMode === "energy" && (
          <>
            <span style={{ color: LED_COLORS.green.on }}>Low</span>
            <span style={{ color: LED_COLORS.orange.on }}>Mid</span>
            <span style={{ color: LED_COLORS.red.on }}>High</span>
            <span>Size = energy</span>
          </>
        )}
        {colorMode === "genre" && (
          <>
            <span>Node color = primary genre</span>
            <span>Size = energy</span>
            <span style={{ color: "rgba(68,136,255,0.8)" }}>Blue edge = genre match</span>
          </>
        )}
        <span style={{ color: "#fff" }}>White ring = seed</span>
      </div>

      <ForceGraph
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
        width={containerRef.current?.clientWidth ?? 700}
        height={500}
        backgroundColor={HARDWARE.groove}
        cooldownTime={5000}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        linkDirectionalParticles={(link: GraphLink) => link.harmonic >= 0.8 ? 2 : 0}
        linkDirectionalParticleWidth={2}
        linkDirectionalParticleColor={() => "rgba(68,255,68,0.6)"}
      />
    </div>
  );
}
