"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  fetchStats,
  fetchPipelineMonitorStatus,
  fetchTracks,
  fetchPlaylists,
  type CatalogStats,
  type PipelineMonitorStatus,
  type Track,
  type Playlist,
} from "@/lib/api";
import { getGreeting } from "./greeting";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hr ago" : `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function formatDateHeader(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function artistColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

function Artwork({ track, size = 34 }: { track: Track; size?: number }) {
  if (track.artwork_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={track.artwork_url}
        alt=""
        style={{ width: size, height: size, borderRadius: 4, objectFit: "cover", flexShrink: 0 }}
      />
    );
  }
  const color = artistColor(track.artist);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        flexShrink: 0,
        background: `linear-gradient(135deg, ${color}55 0%, ${color}22 100%)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <span className="font-sans" style={{ fontSize: size * 0.35, fontWeight: 800, color: `${color}cc` }}>
        {track.artist.slice(0, 2).toUpperCase()}
      </span>
    </div>
  );
}

function StatusPill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div
      className="font-mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 10px",
        borderRadius: 4,
        border: `1px solid ${color}33`,
        background: `${color}11`,
        fontSize: 9,
        fontWeight: 700,
        color,
        letterSpacing: 0.5,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: color, flexShrink: 0 }} />
      {children}
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [pipeline, setPipeline] = useState<PipelineMonitorStatus | null>(null);
  const [recent, setRecent] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, p, t, pl] = await Promise.all([
          fetchStats(),
          fetchPipelineMonitorStatus(),
          fetchTracks({ page: 1, per_page: 5, sort_by: "updated_at", sort_dir: "desc", status: "available" }),
          fetchPlaylists(),
        ]);
        if (cancelled) return;
        setStats(s);
        setPipeline(p);
        setRecent(t.tracks);
        setPlaylists(pl);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "Failed to load dashboard");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const greeting = getGreeting(new Date().getHours());
  const dateStr = formatDateHeader();

  const available = stats?.by_status?.available ?? 0;
  const needsAnalysis = stats
    ? Math.max(
        available - (stats.flags?.enriched_audio ?? 0),
        available - (stats.flags?.cover_art_written ?? 0),
      )
    : 0;

  const agentOnline = !!pipeline && pipeline.agents.length > 0;
  const downloading = pipeline?.downloading ?? 0;
  const paused = pipeline?.paused ?? 0;

  return (
    <div style={{ padding: "32px clamp(16px, 3vw, 36px)", maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 className="font-sans" style={{ fontSize: 28, fontWeight: 900, letterSpacing: -0.8, color: "var(--hw-text)" }}>
          {greeting}
        </h1>
        <p className="font-mono" style={{ fontSize: 10, color: "var(--hw-text-dim)", marginTop: 4, letterSpacing: 0.5 }}>
          {dateStr}
        </p>
      </div>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
        {[
          { value: stats ? stats.total.toLocaleString() : "—", label: "Total Tracks", accent: "var(--hw-text)" },
          { value: stats ? String(playlists.length) : "—", label: "Playlists", accent: "var(--hw-text)" },
          { value: stats ? String(needsAnalysis) : "—", label: "Need Analysis", accent: needsAnalysis > 0 ? "var(--led-orange)" : "var(--hw-text)" },
          { value: stats ? String(downloading) : "—", label: "Downloading", accent: downloading > 0 ? "var(--led-blue)" : "var(--hw-text)" },
        ].map((s) => (
          <div
            key={s.label}
            style={{ background: "var(--hw-panel)", border: "1px solid var(--hw-border)", borderRadius: 8, padding: "18px 20px" }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span className="font-mono" style={{ fontSize: 26, fontWeight: 700, color: s.accent, lineHeight: 1 }}>
                {s.value}
              </span>
              <span className="font-mono uppercase" style={{ fontSize: 9, color: "var(--hw-text-muted)", letterSpacing: 1.5, marginTop: 4 }}>
                {s.label}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Two-col */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr", gap: 16 }}>
        {/* Pipeline status */}
        <div
          style={{
            background: "var(--hw-panel)",
            border: "1px solid var(--hw-border)",
            borderRadius: 8,
            padding: "18px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div className="font-mono uppercase" style={{ fontSize: 9, fontWeight: 700, letterSpacing: 2, color: "var(--hw-text-dim)" }}>
            Pipeline Status
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <StatusPill color={agentOnline ? "var(--led-green)" : "var(--hw-text-dim)"}>
              {agentOnline ? "Agent Online" : "No Agents"}
            </StatusPill>
            <StatusPill color="var(--led-blue)">{downloading} Downloading</StatusPill>
            <StatusPill color="var(--led-orange)">{needsAnalysis} Needs Analysis</StatusPill>
            {paused > 0 && <StatusPill color="var(--hw-text-dim)">{paused} Paused</StatusPill>}
          </div>
          <Link
            href="/pipeline"
            className="font-mono"
            style={{
              marginTop: 4,
              padding: "8px 0",
              background: "none",
              border: "1px solid var(--hw-border-light)",
              borderRadius: 5,
              fontSize: 9,
              fontWeight: 700,
              color: "var(--hw-text-dim)",
              letterSpacing: 0.5,
              textAlign: "center",
              textDecoration: "none",
              display: "block",
            }}
          >
            View Pipeline →
          </Link>
        </div>

        {/* Recent tracks */}
        <div
          style={{ background: "var(--hw-panel)", border: "1px solid var(--hw-border)", borderRadius: 8, overflow: "hidden" }}
        >
          <div
            className="font-mono uppercase"
            style={{ padding: "14px 18px", borderBottom: "1px solid var(--hw-border)", fontSize: 9, fontWeight: 700, letterSpacing: 2, color: "var(--hw-text-dim)" }}
          >
            Recently Added
          </div>

          {loading ? (
            <div style={{ padding: "30px 18px", textAlign: "center" }}>
              <span className="font-mono uppercase" style={{ fontSize: 10, color: "var(--hw-text-dim)", letterSpacing: 1.5 }}>Loading…</span>
            </div>
          ) : recent.length === 0 ? (
            <div style={{ padding: "30px 18px", textAlign: "center" }}>
              <span className="font-sans" style={{ fontSize: 13, color: "var(--hw-text-dim)" }}>No tracks yet — try importing a playlist.</span>
            </div>
          ) : (
            recent.map((t, i) => (
              <div
                key={t.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 18px",
                  borderBottom: i < recent.length - 1 ? "1px solid var(--hw-border)" : "none",
                }}
              >
                <Artwork track={t} size={34} />
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div className="font-sans" style={{ fontSize: 13, fontWeight: 600, color: "var(--hw-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.title}
                  </div>
                  <div className="font-sans" style={{ fontSize: 11, color: "var(--hw-text-dim)", marginTop: 1 }}>
                    {t.artist}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div className="font-mono" style={{ fontSize: 10, fontWeight: 700, color: "var(--led-blue)" }}>
                    {t.tempo ? Math.round(t.tempo) : "—"}
                  </div>
                  <div className="font-mono" style={{ fontSize: 9, color: "var(--hw-text-muted)", marginTop: 1, letterSpacing: 0.5 }}>
                    {timeAgo(t.created_at ?? "")}
                  </div>
                </div>
              </div>
            ))
          )}

          <div style={{ padding: "10px 18px" }}>
            <Link
              href="/catalog"
              className="font-mono"
              style={{
                display: "block",
                padding: "7px 0",
                background: "none",
                border: "1px solid var(--hw-border-light)",
                borderRadius: 5,
                fontSize: 9,
                fontWeight: 700,
                color: "var(--hw-text-dim)",
                letterSpacing: 0.5,
                textAlign: "center",
                textDecoration: "none",
              }}
            >
              View full catalog →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
