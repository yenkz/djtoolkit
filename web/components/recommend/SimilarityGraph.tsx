"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import { EyeOff, Eye } from "lucide-react";
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
  isSeed: boolean;
  val: number;
  x?: number;
  y?: number;
}

interface GraphLink {
  source: number;
  target: number;
  weight: number;
}

export default function SimilarityGraph({ tracks, edges, seedIds, onLike, onDislike }: SimilarityGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [ForceGraph, setForceGraph] = useState<any>(null);
  const [artworkMode, setArtworkMode] = useState(true);
  const { play, pause, currentTrackId, isPlaying } = usePreviewPlayer();

  // Suppress unused var warnings — these props are part of the interface for future use
  void onLike;
  void onDislike;

  useEffect(() => {
    import("react-force-graph-2d").then(mod => setForceGraph(() => mod.default));
  }, []);

  const nodes: GraphNode[] = tracks.map(t => ({
    id: t.id,
    name: t.title,
    artist: t.artist,
    bpm: Math.round(t.tempo ?? 0),
    camelot: t.key_normalized ?? "",
    energy: t.energy ?? 0,
    isSeed: seedIds.has(t.id),
    val: seedIds.has(t.id) ? 3 : 1 + (t.energy ?? 0.5),
  }));

  const links: GraphLink[] = edges.map(e => ({
    source: e.source,
    target: e.target,
    weight: e.weight,
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
    const size = (node.val ?? 1) * 6;
    const x = node.x ?? 0;
    const y = node.y ?? 0;

    if (node.isSeed) {
      ctx.beginPath();
      ctx.arc(x, y, size + 4, 0, 2 * Math.PI);
      ctx.fillStyle = "rgba(59, 130, 246, 0.3)";
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(x, y, size, 0, 2 * Math.PI);
    ctx.fillStyle = node.isSeed ? "#1e40af" : HARDWARE.surface;
    ctx.fill();
    ctx.strokeStyle = node.isSeed ? LED_COLORS.blue.on : LED_COLORS.blue.mid;
    ctx.lineWidth = node.isSeed ? 2 : 1;
    ctx.stroke();
  }, []);

  if (!ForceGraph) return <div style={{ color: HARDWARE.textDim, padding: 20 }}>Loading graph...</div>;

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", height: 500 }}>
      <div style={{
        position: "absolute", top: 8, right: 8, zIndex: 10,
      }}>
        <button onClick={() => setArtworkMode(!artworkMode)} style={{
          background: "rgba(10,10,20,0.85)", padding: "4px 10px", borderRadius: 6,
          fontSize: 10, color: "#fff", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 4,
        }}>
          {artworkMode ? <EyeOff size={12} /> : <Eye size={12} />}
          {artworkMode ? "Clean" : "Artwork"}
        </button>
      </div>

      <ForceGraph
        graphData={{ nodes, links }}
        nodeCanvasObject={nodeCanvasObject}
        linkColor={() => "rgba(59,130,246,0.2)"}
        linkWidth={(link: GraphLink) => (link.weight ?? 0.5) * 2}
        onNodeClick={handleNodeClick}
        nodeLabel={(node: GraphNode) =>
          `${node.artist} \u2014 ${node.name}\n${node.bpm} BPM \u00b7 ${node.camelot} \u00b7 E ${node.energy.toFixed(2)}`
        }
        width={containerRef.current?.clientWidth ?? 700}
        height={500}
        backgroundColor={HARDWARE.groove}
        cooldownTime={3000}
      />
    </div>
  );
}
