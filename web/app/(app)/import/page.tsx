"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  fetchSpotifyPlaylists,
  previewImportCsv,
  previewImportSpotify,
  submitTrackIdPreview,
  confirmImport,
  getTrackIdJobStatus,
  fetchAgents,
  importFolder,
  sendAgentCommand,
  getAgentCommandResult,
  fetchPipelineStatus,
  registerAgent,
  disconnectSpotify,
  parseCollection,
  fetchTracksByIds,
  type Track,
  type PreviewTrack,
  type TrackIdJobStatus,
  type ParseResult,
  type Agent,
} from "@/lib/api";
import { FolderBrowser } from "@/components/folder-import/FolderBrowser";
import { createClient } from "@/lib/supabase/client";
import { usePreviewPlayer } from "@/lib/preview-player-context";
import LCDDisplay from "@/components/ui/LCDDisplay";
import Checkbox from "@/components/ui/Checkbox";
import ActionButton from "@/components/ui/ActionButton";

// ─── Source Icons (SVG) ────────────────────────────────────────────────────────

const SRC_ICONS = {
  spotify: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="#1DB954" strokeWidth="1.5" />
      <path d="M7.5 10.5c2.5-1 5.5-1 8 0" stroke="#1DB954" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8.5 13c2-.8 4.5-.8 6.5 0" stroke="#1DB954" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M9.5 15.5c1.5-.6 3.5-.6 5 0" stroke="#1DB954" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  csv: (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--hw-text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="12" y2="17" />
    </svg>
  ),
  trackid: (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--hw-text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polygon points="10 8 16 12 10 16 10 8" />
    </svg>
  ),
  agent: (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--hw-text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <path d="M16 3l2 2-2 2" />
    </svg>
  ),
  homebrew: (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#D4A030" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v2" /><path d="M12 2v2" />
      <path d="M6 6h10v10a4 4 0 01-4 4H10a4 4 0 01-4-4V6z" />
      <path d="M16 8h2a2 2 0 012 2v2a2 2 0 01-2 2h-2" />
      <path d="M6 6c0 0-1-1.5 2-3" /><path d="M10 6c0 0 0-2 2-3" />
    </svg>
  ),
  download: (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--hw-text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  traktor: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="var(--hw-text-dim)" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="3" stroke="var(--hw-text-dim)" strokeWidth="1.5" />
      <line x1="12" y1="3" x2="12" y2="9" stroke="var(--hw-text-dim)" strokeWidth="1.5" />
      <line x1="12" y1="15" x2="12" y2="21" stroke="var(--hw-text-dim)" strokeWidth="1.5" />
    </svg>
  ),
  rekordbox: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="var(--hw-text-dim)" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="4" stroke="var(--hw-text-dim)" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="1" fill="var(--hw-text-dim)" />
    </svg>
  ),
  serato: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <path d="M4 12c0-4.4 3.6-8 8-8s8 3.6 8 8-3.6 8-8 8" stroke="var(--hw-text-muted)" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 12a4 4 0 108 0 4 4 0 00-8 0" stroke="var(--hw-text-muted)" strokeWidth="1.5" />
    </svg>
  ),
};

// ─── MiniArt ───────────────────────────────────────────────────────────────────

function MiniArt({ name, src, size = 40 }: { name: string; src?: string | null; size?: number }) {
  // Generate a deterministic gradient color from the name
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  const color = `hsl(${hue}, 55%, 45%)`;
  const abbrev = name.slice(0, 2).toUpperCase();

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        className="flex-shrink-0 object-cover"
        style={{
          width: size,
          height: size,
          minWidth: size,
          borderRadius: 5,
        }}
      />
    );
  }

  return (
    <div
      className="flex items-center justify-center flex-shrink-0"
      style={{
        width: size,
        height: size,
        minWidth: size,
        borderRadius: 5,
        background: `linear-gradient(135deg, ${color} 0%, ${color}88 100%)`,
      }}
    >
      <span
        className="font-sans font-extrabold text-white"
        style={{
          fontSize: size * 0.3,
          textShadow: "0 1px 2px rgba(0,0,0,0.3)",
        }}
      >
        {abbrev}
      </span>
    </div>
  );
}

// ─── SourceCard ────────────────────────────────────────────────────────────────

function SourceCard({
  icon,
  title,
  desc,
  active,
  disabled,
  comingSoon,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  active?: boolean;
  disabled?: boolean;
  comingSoon?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="relative transition-all duration-200"
      style={{
        background: active ? "var(--hw-card-hover)" : "var(--hw-card-bg)",
        border: `1.5px solid ${active ? "color-mix(in srgb, var(--led-blue) 35%, transparent)" : "var(--hw-card-border)"}`,
        borderRadius: 8,
        padding: "clamp(18px, 2.5vw, 24px)",
        boxShadow: active
          ? "0 0 20px color-mix(in srgb, var(--led-blue) 8%, transparent), 0 4px 12px rgba(0,0,0,0.1)"
          : "none",
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "not-allowed" : "default",
      }}
    >
      <div
        className="flex items-center justify-between gap-3.5"
        style={{ marginBottom: children ? 16 : 0 }}
      >
        <div className="flex items-center gap-3.5">
          <div className="w-9 h-9 flex items-center justify-center flex-shrink-0">
            {icon}
          </div>
          <div>
            <div className="font-sans text-base font-bold" style={{ color: "var(--hw-text)", letterSpacing: -0.2 }}>
              {title}
            </div>
            <div className="font-sans text-[13px] mt-0.5" style={{ color: "var(--hw-text-dim)", lineHeight: 1.4 }}>
              {desc}
            </div>
          </div>
        </div>
        {comingSoon && (
          <span
            className="font-mono text-[9px] font-bold uppercase whitespace-nowrap"
            style={{
              letterSpacing: 1.5,
              color: "var(--hw-text-muted)",
              background: "var(--hw-raised)",
              padding: "4px 12px",
              borderRadius: 4,
            }}
          >
            COMING SOON
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ─── SectionHeader ────────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <div
      className="font-mono text-[10px] font-bold uppercase"
      style={{
        letterSpacing: 2,
        color: "var(--hw-text-muted)",
        padding: "20px 0 8px",
      }}
    >
      {label}
    </div>
  );
}

// ─── CopyBlock ─────────────────────────────────────────────────────────────────

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div
      className="flex items-center justify-between gap-3 mb-2 transition-colors"
      style={{
        background: "var(--hw-code-bg)",
        border: "1px solid var(--hw-code-border)",
        borderRadius: 5,
        padding: "12px 16px",
      }}
    >
      <code className="font-mono text-[13px] break-all" style={{ color: "var(--hw-text)", letterSpacing: 0.3 }}>
        {text}
      </code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="font-mono text-[10px] font-bold flex-shrink-0 cursor-pointer transition-colors"
        style={{
          letterSpacing: 1,
          color: copied ? "var(--hw-success-text)" : "var(--hw-text-dim)",
          padding: "4px 10px",
          borderRadius: 3,
        }}
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

// ─── StepBar ───────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3;

const STEP_LABELS = ["IMPORT", "REVIEW", "DOWNLOAD AGENT"] as const;

function StepBar({ current }: { current: Step }) {
  return (
    <div
      className="flex items-center"
      style={{
        padding: "0 clamp(16px, 2vw, 32px)",
        height: 48,
        borderBottom: "1px solid var(--hw-border-light)",
      }}
    >
      {STEP_LABELS.map((label, i) => {
        const stepNum = (i + 1) as Step;
        const isDone = stepNum < current;
        const isActive = stepNum === current;
        return (
          <div key={label} className="flex-1 flex items-center">
            <div className="flex items-center gap-2 whitespace-nowrap">
              {isDone ? (
                <span className="font-mono text-[11px] font-bold" style={{ color: "var(--hw-success-text)" }}>
                  ✓
                </span>
              ) : (
                <span
                  className="font-mono text-[11px] font-bold flex items-center justify-center transition-all duration-300"
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background: isActive ? "var(--led-blue)" : "transparent",
                    color: isActive ? "#fff" : "var(--hw-text-muted)",
                    border: isActive ? "none" : "1.5px solid var(--hw-border-light)",
                  }}
                >
                  {stepNum}
                </span>
              )}
              <span
                className="font-mono text-[11px] font-bold transition-all duration-300"
                style={{
                  letterSpacing: 1.5,
                  color: isDone ? "var(--hw-success-text)" : isActive ? "var(--hw-text)" : "var(--hw-text-muted)",
                }}
              >
                {label}
              </span>
            </div>
            {i < 2 && (
              <div
                className="flex-1 transition-all duration-300"
                style={{
                  height: 2,
                  margin: "0 16px",
                  background: isDone ? "var(--led-blue)" : "var(--hw-border-light)",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── TrackReviewRow ────────────────────────────────────────────────────────────

function TrackReviewRow({
  track,
  isSelected,
  isOwned,
  onToggle,
}: {
  track: Track;
  isSelected: boolean;
  isOwned: boolean;
  onToggle: () => void;
}) {
  const { currentTrackId, isPlaying, play, playUrl, pause } = usePreviewPlayer();
  const previewTrack = track as unknown as PreviewTrack;
  const spotifyUri = previewTrack.spotify_uri;
  const previewAudioUrl = previewTrack.preview_url;
  const canPlay = !!(spotifyUri || previewAudioUrl);
  const isThisPlaying = currentTrackId === track.id && isPlaying;
  const isThisActive = currentTrackId === track.id;
  // Preview tracks don't have a numeric id yet — derive a stable one from _key
  const playId = track.id ?? Math.abs((previewTrack._key ?? "").split("").reduce((a: number, c: string) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0));

  const handlePlay = () => {
    if (!canPlay) return;
    if (isThisPlaying) { pause(); return; }
    if (spotifyUri) {
      play(playId, spotifyUri);
    } else if (previewAudioUrl) {
      playUrl(playId, previewAudioUrl, { title: track.title ?? undefined, artist: track.artist ?? undefined });
    }
  };

  return (
    <div
      onClick={onToggle}
      className="grid items-center cursor-pointer transition-colors duration-100 border-b last:border-0"
      style={{
        gridTemplateColumns: "28px 44px 32px 2fr 1.5fr 1fr",
        padding: "10px 16px",
        gap: 12,
        borderColor: "var(--hw-border)",
        background: isThisActive
          ? "color-mix(in srgb, var(--led-green) 5%, transparent)"
          : isSelected ? "transparent" : "var(--hw-body)",
        opacity: isSelected ? 1 : 0.5,
      }}
    >
      <Checkbox
        checked={isSelected}
        onChange={() => onToggle()}
      />
      <MiniArt name={track.artist ?? track.title ?? "??"} src={previewTrack.artwork_url ?? track.artwork_url} size={40} />
      {/* Play/Pause preview button */}
      <div
        role="button"
        tabIndex={0}
        aria-label={isThisPlaying ? "Pause preview" : "Play preview"}
        onClick={(e) => {
          e.stopPropagation();
          handlePlay();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            handlePlay();
          }
        }}
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          background: isThisActive ? "var(--hw-groove, #0E0C0E)" : "var(--hw-raised)",
          border: isThisActive ? "2px solid var(--led-green)" : "1.5px solid var(--hw-border-light)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: canPlay ? "pointer" : "default",
          opacity: canPlay ? 1 : 0.25,
          boxShadow: isThisActive ? "0 0 8px var(--led-green-dim, rgba(68,255,68,0.3))" : "none",
          transition: "all 0.2s",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {isThisPlaying ? (
          <svg width="8" height="10" viewBox="0 0 12 14">
            <rect x="1" y="0" width="3.5" height="14" rx="1" fill="var(--led-green)" />
            <rect x="7.5" y="0" width="3.5" height="14" rx="1" fill="var(--led-green)" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 24 24">
            <path d="M6 3l12 9-12 9V3z" fill={canPlay ? "var(--led-green-dim, #6A8A6A)" : "var(--hw-text-muted)"} />
          </svg>
        )}
      </div>
      <span
        className="font-sans text-sm font-semibold overflow-hidden text-ellipsis whitespace-nowrap"
        style={{ color: isThisActive ? "var(--led-green)" : isSelected ? "var(--hw-text)" : "var(--hw-text-dim)" }}
      >
        {track.title}
      </span>
      <span
        className="font-sans text-[13px] overflow-hidden text-ellipsis whitespace-nowrap"
        style={{ color: "var(--hw-text-sec)" }}
      >
        {track.artist}
      </span>
      <div className="flex items-center justify-end">
        {isOwned && (
          <span
            className="font-mono text-[10px] font-bold uppercase whitespace-nowrap"
            style={{
              color: "var(--hw-text-muted)",
              background: "var(--hw-raised)",
              padding: "3px 8px",
              borderRadius: 4,
              letterSpacing: 0.5,
            }}
          >
            Already owned
          </span>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function ImportPage() {
  const [step, setStep] = useState<Step>(1);
  const [candidates, setCandidates] = useState<Track[]>([]);
  const [apiKey, setApiKey] = useState<string>("");
  const [machineName] = useState("My Mac");
  const [step1HasSource, setStep1HasSource] = useState(false);
  const [step1SourceSummary, setStep1SourceSummary] = useState("");
  const [step2SelectedCount, setStep2SelectedCount] = useState(0);
  const [agentConnected, setAgentConnected] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <div className="flex flex-col h-full">
      <StepBar current={step} />

      <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 80 }}>
        <div className="max-w-[800px] mx-auto">
          {step === 1 && (
            <Step1Import
              searchParams={searchParams}
              onSourceChange={(has, summary) => {
                setStep1HasSource(has);
                setStep1SourceSummary(summary);
              }}
              onComplete={(tracks) => {
                setCandidates(tracks);
                setStep(2);
              }}
            />
          )}
          {step === 2 && (
            <Step2Review
              candidates={candidates}
              onSelectedChange={setStep2SelectedCount}
              onBack={() => setStep(1)}
              onComplete={() => setStep(3)}
            />
          )}
          {step === 3 && (
            <Step3Agent
              apiKey={apiKey}
              setApiKey={setApiKey}
              machineName={machineName}
              onAgentChange={setAgentConnected}
              onDone={() => router.push("/pipeline")}
            />
          )}
        </div>
      </div>

      {/* Sticky footer */}
      <div
        className="flex items-center justify-between flex-shrink-0"
        style={{
          borderTop: "1px solid var(--hw-border-light)",
          background: "color-mix(in srgb, var(--hw-surface) 94%, transparent)",
          backdropFilter: "blur(8px)",
          padding: "14px clamp(16px, 3vw, 32px)",
        }}
      >
        <div>
          {step === 1 && (
            <span className="font-sans text-sm" style={{ color: "var(--hw-text-dim)" }}>
              {step1HasSource ? step1SourceSummary : "Select at least one source"}
            </span>
          )}
          {step > 1 && (
            <button
              onClick={() => setStep((step - 1) as Step)}
              className="font-sans text-sm cursor-pointer py-2"
              style={{ color: "var(--hw-text-dim)" }}
            >
              &#8592; Back
            </button>
          )}
        </div>
        <div className="flex items-center gap-4">
          {step === 1 && (
            <ActionButton
              disabled={!step1HasSource}
              onClick={() => {
                // Trigger the import from step 1 - handled via form submit
                const btn = document.getElementById("step1-continue-btn");
                if (btn) btn.click();
              }}
            >
              Review tracks &#8594;
            </ActionButton>
          )}
          {step === 2 && (
            <ActionButton
              disabled={step2SelectedCount === 0}
              onClick={() => {
                const btn = document.getElementById("step2-confirm-btn");
                if (btn) btn.click();
              }}
            >
              Queue {step2SelectedCount} download{step2SelectedCount !== 1 ? "s" : ""} &#8594;
            </ActionButton>
          )}
          {step === 3 && agentConnected && (
            <ActionButton onClick={() => router.push("/pipeline")}>
              Go to Pipeline &#8594;
            </ActionButton>
          )}
          {step === 3 && (
            <span
              onClick={() => { window.location.href = "/catalog"; }}
              className="font-sans text-[13px] cursor-pointer"
              style={{ color: "var(--hw-text-muted)" }}
            >
              Skip for now
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: IMPORT SOURCES
// ═══════════════════════════════════════════════════════════════════════════════

const API_URL = "";
const SESSION_KEY = "djtoolkit_onboarding_state";

interface Step1Props {
  searchParams: ReturnType<typeof useSearchParams>;
  onSourceChange: (hasSource: boolean, summary: string) => void;
  onComplete: (tracks: Track[]) => void;
}

function Step1Import({ searchParams, onSourceChange, onComplete }: Step1Props) {
  const router = useRouter();
  const [playlists, setPlaylists] = useState<
    { id: string; name: string; track_count?: number | null; owner?: string; image_url?: string; is_owner?: boolean }[]
  >([]);
  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvRowCount, setCsvRowCount] = useState(0);
  const [trackIdUrl, setTrackIdUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [trackIdStatus, setTrackIdStatus] = useState<TrackIdJobStatus | null>(null);
  const [trackIdElapsed, setTrackIdElapsed] = useState("");
  const trackIdStartRef = useRef<number | null>(null);
  const trackIdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [showExportifyHint, setShowExportifyHint] = useState(false);
  const [djFile, setDjFile] = useState<File | null>(null);
  const [_djParseResult, setDjParseResult] = useState<ParseResult | null>(null);
  const [djDraggingTarget, setDjDraggingTarget] = useState<"traktor" | "rekordbox" | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [_agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [folderScanning, setFolderScanning] = useState(false);
  const [folderScanResult, setFolderScanResult] = useState<{
    path: string;
    files: { name: string; size_bytes: number; extension: string; rel_path: string }[];
    total_count: number;
  } | null>(null);
  const [folderImporting, setFolderImporting] = useState(false);

  function formatElapsed(startMs: number): string {
    const sec = Math.floor((Date.now() - startMs) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function friendlyStep(step: string): { label: string; detail: string } {
    const s = step.toLowerCase();
    if (s.includes("queue") || s.includes("submitted"))
      return { label: "Queued", detail: "Waiting for analysis to start…" };
    if (s.includes("download"))
      return { label: "Downloading", detail: "Downloading audio…" };
    if (s.includes("preparing"))
      return { label: "Preparing", detail: "Generating sample points…" };
    // "Identifying 12/60 samples (5 found)…"
    const sampleMatch = step.match(/(\d+)\/(\d+)\s*samples?\s*\((\d+)\s*found\)/i);
    if (sampleMatch) {
      const [, current, total, found] = sampleMatch;
      return {
        label: `Identifying ${current}/${total}`,
        detail: `${found} track${found === "1" ? "" : "s"} found so far`,
      };
    }
    if (s.includes("identify"))
      return { label: "Identifying", detail: "Matching audio against Shazam…" };
    if (s.includes("dedup"))
      return { label: "Finishing", detail: "Deduplicating results…" };
    if (s.includes("done"))
      return { label: step, detail: "" };
    return { label: step || "Processing", detail: "Analyzing your mix…" };
  }

  function startTrackIdTimer() {
    trackIdStartRef.current = Date.now();
    setTrackIdElapsed("0s");
    trackIdTimerRef.current = setInterval(() => {
      if (trackIdStartRef.current) setTrackIdElapsed(formatElapsed(trackIdStartRef.current));
    }, 1000);
  }

  function stopTrackIdTimer() {
    if (trackIdTimerRef.current) {
      clearInterval(trackIdTimerRef.current);
      trackIdTimerRef.current = null;
    }
    trackIdStartRef.current = null;
    setTrackIdElapsed("");
  }

  const loadPlaylists = useCallback(async () => {
    try {
      const data = await fetchSpotifyPlaylists();
      setPlaylists(data);
      setSpotifyConnected(true);
    } catch (err: unknown) {
      setSpotifyConnected(false);
      if (err instanceof Error && !err.message.includes("not connected")) {
        toast.error(`Couldn't load playlists: ${err.message}`);
      }
    }
  }, []);

  useEffect(() => {
    const isReturningFromSpotify = searchParams.get("spotify") === "connected";
    if (isReturningFromSpotify) {
      toast.success("Spotify connected! Loading your playlists...");
      window.history.replaceState({}, "", "/import");
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) {
        try {
          const { csvName } = JSON.parse(saved);
          if (csvName) {
            toast("CSV file was cleared during Spotify auth. Please re-upload.");
          }
        } catch { /* ignore */ }
        sessionStorage.removeItem(SESSION_KEY);
      }
    }
    if (searchParams.get("spotify") === "error") {
      toast.error("Spotify connection failed. Please try again.");
      window.history.replaceState({}, "", "/import");
    }
    loadPlaylists();
  }, [loadPlaylists, searchParams]);

  function handleCsvFile(file: File) {
    setCsvFile(file);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.split("\n").filter((l) => l.trim()).length;
      setCsvRowCount(Math.max(0, lines - 1));
    };
    reader.readAsText(file);
  }

  const selectedPlaylist = playlists.find((p) => p.id === selectedPlaylistId);
  const totalTracks = (selectedPlaylist?.track_count ?? null) !== null
    ? (selectedPlaylist!.track_count! + csvRowCount)
    : csvRowCount;
  const trackIdValid = /youtu\.?be/.test(trackIdUrl) || trackIdUrl.includes("youtube.com/watch") || trackIdUrl.includes("soundcloud.com/");
  const djReady = djFile !== null;
  const sourcesSelected = (selectedPlaylistId ? 1 : 0) + (csvFile ? 1 : 0) + (trackIdValid ? 1 : 0) + (djReady ? 1 : 0);

  // Notify parent of source state
  useEffect(() => {
    const summary =
      sourcesSelected > 0
        ? `${sourcesSelected} source${sourcesSelected > 1 ? "s" : ""} selected` +
          (totalTracks > 0 ? ` \u00b7 ${totalTracks} tracks` : "") +
          (trackIdValid ? " + YouTube mix" : "")
        : "Select at least one source";
    onSourceChange(sourcesSelected > 0, summary);
  }, [sourcesSelected, totalTracks, trackIdValid, onSourceChange]);

  useEffect(() => {
    fetchAgents()
      .then((list) => {
        setAgents(list);
        // Auto-select first online agent
        const now = Date.now();
        const live = list.find(
          (a) => a.last_seen_at && now - new Date(a.last_seen_at).getTime() < 60_000,
        );
        if (live) setSelectedAgent(live.id);
      })
      .catch(() => {});
  }, []);

  async function handleContinue() {
    if (sourcesSelected === 0) return;
    setLoading(true);
    setTrackIdStatus(null);
    try {
      // Parallel preview calls for CSV and Spotify
      const previewCalls: Promise<{ tracks: PreviewTrack[] }>[] = [];
      if (selectedPlaylistId) previewCalls.push(previewImportSpotify(selectedPlaylistId));
      if (csvFile) previewCalls.push(previewImportCsv(csvFile));
      const previewResults = await Promise.all(previewCalls);

      // TrackID: cache hit returns data directly, cache miss returns job_id for polling
      let trackIdTracks: PreviewTrack[] = [];
      if (trackIdValid) {
        const trackIdResult = await submitTrackIdPreview(trackIdUrl);

        if ("tracks" in trackIdResult) {
          // Cache hit — data returned directly
          trackIdTracks = trackIdResult.tracks;
        } else {
          // Cache miss — poll until completed or failed
          const { job_id } = trackIdResult;
          startTrackIdTimer();
          try {
            while (true) {
              await new Promise((r) => setTimeout(r, 5000));
              const s = await getTrackIdJobStatus(job_id);
              setTrackIdStatus(s);
              if (s.status === "completed") {
                stopTrackIdTimer();
                const result = s.result as unknown as { tracks: PreviewTrack[] } | null;
                if (!result || result.tracks.length === 0) {
                  toast.warning("TrackID found no identifiable tracks in this mix.");
                  if (!selectedPlaylistId && !csvFile) {
                    setLoading(false);
                    setTrackIdStatus(null);
                    return;
                  }
                } else {
                  trackIdTracks = result.tracks;
                }
                break;
              }
              if (s.status === "failed") {
                stopTrackIdTimer();
                throw new Error(s.error ?? "TrackID job failed");
              }
            }
          } catch (e) {
            stopTrackIdTimer();
            throw e;
          }
        }

        if (trackIdTracks.length === 0 && !selectedPlaylistId && !csvFile) {
          toast.warning("TrackID found no identifiable tracks in this mix.");
          setLoading(false);
          setTrackIdStatus(null);
          return;
        }
      }

      // DJ file import stays as-is (parseCollection returns ParseResult with track_ids,
      // not PreviewTrack[]) — these tracks are already in the DB, so fetch them separately
      let djTracks: Track[] = [];
      if (djFile) {
        const djResult = await parseCollection(djFile);
        if (djResult.track_ids.length > 0) {
          djTracks = await fetchTracksByIds(djResult.track_ids);
        }
      }

      const allPreviewTracks = [
        ...previewResults.flatMap((r) => r.tracks),
        ...trackIdTracks,
      ];

      // Combine preview tracks (cast to Track[]) with DJ tracks (already Track[])
      onComplete([
        ...allPreviewTracks as unknown as Track[],
        ...djTracks,
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Import failed";
      if (msg.includes("exportify.app") || msg.includes("403")) {
        setShowExportifyHint(true);
        dialogRef.current?.showModal();
      } else {
        toast.error(msg);
      }
    } finally {
      setLoading(false);
      setTrackIdStatus(null);
    }
  }

  async function handleSpotifyDisconnect() {
    try {
      await disconnectSpotify();
      setSpotifyConnected(false);
      setPlaylists([]);
      setSelectedPlaylistId(null);
    } catch {
      toast.error("Failed to disconnect Spotify");
    }
  }

  async function handleSpotifyConnect() {
    if (csvFile) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ csvName: csvFile.name }));
    }
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token ?? "";
    window.location.href = `${API_URL}/api/auth/spotify/connect?token=${encodeURIComponent(token)}&return_to=/import`;
  }

  return (
    <div style={{ padding: "clamp(24px, 4vw, 40px)" }}>
      <h2
        className="font-sans font-black"
        style={{ fontSize: "clamp(24px, 3.5vw, 32px)", letterSpacing: -1, marginBottom: 8, lineHeight: 1.1 }}
      >
        Where&apos;s your music coming from?
      </h2>
      <p
        className="font-sans text-[15px]"
        style={{ color: "var(--hw-text-sec)", marginBottom: 32, lineHeight: 1.6, maxWidth: 500 }}
      >
        You can import from multiple sources — all tracks will be combined in step 2.
      </p>

      {/* Hidden button for sticky footer trigger */}
      <button id="step1-continue-btn" onClick={handleContinue} className="hidden" />

      <div className="flex flex-col gap-3.5">
        <SectionHeader label="Discovery" />

        {/* ── Spotify ── */}
        <SourceCard
          icon={SRC_ICONS.spotify}
          title="Spotify"
          desc={spotifyConnected ? "Connected to your account" : "Connect your Spotify account"}
          active={spotifyConnected}
        >
          {!spotifyConnected ? (
            <ActionButton onClick={handleSpotifyConnect}>Connect Spotify</ActionButton>
          ) : (
            <div>
              <div className="flex items-center gap-2.5 mb-3.5">
                <span
                  className="font-mono text-[10px] font-bold uppercase"
                  style={{
                    color: "var(--hw-success-text)",
                    background: "var(--hw-success-bg)",
                    border: "1px solid var(--hw-success-border)",
                    padding: "4px 12px",
                    borderRadius: 4,
                    letterSpacing: 1,
                  }}
                >
                  ✓ CONNECTED
                </span>
                <span
                  onClick={handleSpotifyDisconnect}
                  className="font-sans text-[13px] cursor-pointer underline decoration-1"
                  style={{
                    color: "var(--hw-text-dim)",
                    textDecorationColor: "var(--hw-text-muted)",
                    textUnderlineOffset: 2,
                  }}
                >
                  Disconnect
                </span>
              </div>
              <div
                className="font-mono text-[10px] font-bold uppercase mb-2.5"
                style={{ color: "var(--hw-text-dim)", letterSpacing: 1.5 }}
              >
                Select Playlist
              </div>
              <div
                className="overflow-hidden"
                style={{
                  maxHeight: 260,
                  overflowY: "auto",
                  border: "1px solid var(--hw-border-light)",
                  borderRadius: 6,
                }}
              >
                {playlists.map((p) => {
                  const isLiked = p.id === "liked";
                  const sel = selectedPlaylistId === p.id;
                  return (
                    <div
                      key={p.id}
                      onClick={() => setSelectedPlaylistId(p.id === selectedPlaylistId ? null : p.id)}
                      className="flex items-center justify-between cursor-pointer transition-colors duration-150"
                      style={{
                        padding: "12px 16px",
                        borderBottom: "1px solid var(--hw-border)",
                        background: sel ? "color-mix(in srgb, var(--led-blue) 12%, transparent)" : "transparent",
                        gap: 14,
                      }}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className="flex items-center justify-center flex-shrink-0 transition-colors"
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: "50%",
                            border: `2px solid ${sel ? "var(--led-blue)" : "var(--hw-border-light)"}`,
                          }}
                        >
                          {sel && (
                            <div
                              style={{
                                width: 9,
                                height: 9,
                                borderRadius: "50%",
                                background: "var(--led-blue)",
                                boxShadow: "0 0 12px color-mix(in srgb, var(--led-blue) 33%, transparent)",
                              }}
                            />
                          )}
                        </div>
                        {isLiked ? (
                          <div
                            className="w-11 h-11 rounded flex-shrink-0 flex items-center justify-center text-white text-sm"
                            style={{
                              background: "linear-gradient(135deg, var(--led-blue), color-mix(in srgb, var(--led-blue) 60%, transparent))",
                            }}
                          >
                            &#9829;
                          </div>
                        ) : p.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.image_url} alt="" className="w-11 h-11 rounded flex-shrink-0 object-cover" />
                        ) : (
                          <MiniArt name={p.name} size={44} />
                        )}
                        <div>
                          <div className="font-sans text-sm font-semibold" style={{ color: "var(--hw-text)", lineHeight: 1.3 }}>
                            {p.name}
                          </div>
                          <div className="font-sans text-xs mt-0.5" style={{ color: "var(--hw-text-dim)" }}>
                            {p.owner ? `by ${p.owner}` : ""}
                          </div>
                        </div>
                      </div>
                      <span
                        className="font-mono text-xs font-semibold whitespace-nowrap"
                        style={{ color: "var(--hw-text-muted)" }}
                      >
                        {p.track_count != null ? `${p.track_count} tracks` : "\u2014"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </SourceCard>

        {/* ── CSV Upload ── */}
        <SourceCard
          icon={SRC_ICONS.csv}
          title="Exported Spotify Playlist (CSV)"
          desc="Upload a CSV exported from exportify.app"
          active={!!csvFile}
        >
          <div className="flex items-center gap-3">
            <ActionButton
              variant="outline"
              onClick={() => document.getElementById("csv-upload")?.click()}
            >
              {csvFile ? "Change" : "Upload file"}
            </ActionButton>
            <input
              id="csv-upload"
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleCsvFile(f);
              }}
            />
          </div>
          {csvFile && (
            <div className="font-mono text-[11px] font-bold mt-2.5" style={{ color: "var(--hw-success-text)" }}>
              ✓ {csvFile.name} ({csvRowCount} tracks)
            </div>
          )}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files[0];
              if (f) handleCsvFile(f);
            }}
            className="text-center mt-3"
            style={{
              border: `1.5px dashed ${dragging ? "var(--led-blue)" : "var(--hw-border-light)"}`,
              borderRadius: 6,
              padding: 18,
              background: dragging ? "color-mix(in srgb, var(--led-blue) 10%, transparent)" : "transparent",
              transition: "all 0.2s",
            }}
          >
            <span className="font-sans text-[13px]" style={{ color: dragging ? "var(--led-blue)" : "var(--hw-text-muted)" }}>
              Or drag &amp; drop CSV here
            </span>
          </div>
        </SourceCard>

        {/* ── TrackID ── */}
        <SourceCard
          icon={SRC_ICONS.trackid}
          title="TrackID"
          desc="Identify tracks from a YouTube DJ set or mix"
          active={trackIdValid}
        >
          <input
            type="url"
            placeholder="YouTube or SoundCloud URL…"
            value={trackIdUrl}
            onChange={(e) => setTrackIdUrl(e.target.value)}
            className="w-full font-mono text-[13px] outline-none transition-all duration-200"
            style={{
              color: "var(--hw-text)",
              background: trackIdUrl ? "var(--hw-input-focus)" : "var(--hw-input-bg)",
              border: `1.5px solid ${trackIdUrl ? "color-mix(in srgb, var(--led-blue) 35%, transparent)" : "var(--hw-input-border)"}`,
              borderRadius: 5,
              padding: "12px 16px",
              boxShadow: trackIdUrl ? "0 0 0 3px color-mix(in srgb, var(--led-blue) 7%, transparent)" : "none",
            }}
          />
          {trackIdValid && !trackIdStatus && (
            <div className="mt-2.5">
              <span
                className="font-mono text-[10px] font-bold uppercase"
                style={{
                  color: "var(--hw-success-text)",
                  background: "var(--hw-success-bg)",
                  border: "1px solid var(--hw-success-border)",
                  padding: "4px 10px",
                  borderRadius: 4,
                }}
              >
                ✓ URL SET
              </span>
              <p className="mt-2 font-sans text-xs" style={{ color: "var(--hw-warning-text)" }}>
                Track identification runs during import and may take a few minutes.
              </p>
            </div>
          )}
          {trackIdStatus && (() => {
            const { label, detail } = friendlyStep(trackIdStatus.step);
            const inProgress = trackIdStatus.progress < 100;
            return (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    {inProgress && (
                      <div
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{
                          background: "var(--led-blue)",
                          animation: "led-pulse 1.5s infinite",
                        }}
                      />
                    )}
                    <span className="font-mono text-xs" style={{ color: "var(--led-blue)" }}>
                      {label}
                    </span>
                  </div>
                  <span className="font-mono text-xs" style={{ color: "var(--hw-text-dim)" }}>
                    {trackIdStatus.progress}%
                  </span>
                </div>
                {detail && (
                  <p className="font-sans text-xs mb-2" style={{ color: "var(--hw-text-sec)" }}>
                    {detail}
                  </p>
                )}
                <div className="w-full rounded-full h-1.5 overflow-hidden" style={{ background: "var(--hw-raised)" }}>
                  <div
                    className="h-1.5 rounded-full transition-all duration-500"
                    style={{
                      width: `${trackIdStatus.progress}%`,
                      background: "var(--led-blue)",
                      ...(inProgress ? { animation: "led-pulse 1.5s infinite" } : {}),
                    }}
                  />
                </div>
                {trackIdElapsed && (
                  <div className="mt-1.5 font-mono text-[10px]" style={{ color: "var(--hw-text-dim)" }}>
                    Elapsed: {trackIdElapsed}
                  </div>
                )}
              </div>
            );
          })()}
        </SourceCard>

        <SectionHeader label="DJ Software" />

        {/* ── Traktor ── */}
        <SourceCard
          icon={SRC_ICONS.traktor}
          title="Traktor"
          desc="Import your Traktor NML collection"
          active={!!djFile && djFile.name.endsWith(".nml")}
        >
          <div className="flex items-center gap-3">
            <ActionButton
              variant="outline"
              onClick={() => document.getElementById("traktor-upload")?.click()}
            >
              {djFile?.name.endsWith(".nml") ? "Change" : "Upload .nml"}
            </ActionButton>
            <input
              id="traktor-upload"
              type="file"
              accept=".nml"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) { setDjFile(f); setDjParseResult(null); }
              }}
            />
          </div>
          {djFile?.name.endsWith(".nml") && (
            <div className="font-mono text-[11px] font-bold mt-2.5" style={{ color: "var(--hw-success-text)" }}>
              ✓ {djFile.name}
            </div>
          )}
          <div
            onDragOver={(e) => { e.preventDefault(); setDjDraggingTarget("traktor"); }}
            onDragLeave={() => setDjDraggingTarget(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDjDraggingTarget(null);
              const f = e.dataTransfer.files[0];
              if (f && f.name.endsWith(".nml")) { setDjFile(f); setDjParseResult(null); }
            }}
            className="text-center mt-3"
            style={{
              border: `1.5px dashed ${djDraggingTarget === "traktor" ? "var(--led-blue)" : "var(--hw-border-light)"}`,
              borderRadius: 6,
              padding: 18,
              background: djDraggingTarget === "traktor" ? "color-mix(in srgb, var(--led-blue) 10%, transparent)" : "transparent",
              transition: "all 0.2s",
            }}
          >
            <span className="font-sans text-[13px]" style={{ color: djDraggingTarget === "traktor" ? "var(--led-blue)" : "var(--hw-text-muted)" }}>
              Or drag &amp; drop .nml here
            </span>
          </div>
        </SourceCard>

        {/* ── Rekordbox ── */}
        <SourceCard
          icon={SRC_ICONS.rekordbox}
          title="Rekordbox"
          desc="Import your Rekordbox XML collection"
          active={!!djFile && djFile.name.endsWith(".xml")}
        >
          <div className="flex items-center gap-3">
            <ActionButton
              variant="outline"
              onClick={() => document.getElementById("rekordbox-upload")?.click()}
            >
              {djFile?.name.endsWith(".xml") ? "Change" : "Upload .xml"}
            </ActionButton>
            <input
              id="rekordbox-upload"
              type="file"
              accept=".xml"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) { setDjFile(f); setDjParseResult(null); }
              }}
            />
          </div>
          {djFile?.name.endsWith(".xml") && (
            <div className="font-mono text-[11px] font-bold mt-2.5" style={{ color: "var(--hw-success-text)" }}>
              ✓ {djFile.name}
            </div>
          )}
          <div
            onDragOver={(e) => { e.preventDefault(); setDjDraggingTarget("rekordbox"); }}
            onDragLeave={() => setDjDraggingTarget(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDjDraggingTarget(null);
              const f = e.dataTransfer.files[0];
              if (f && f.name.endsWith(".xml")) { setDjFile(f); setDjParseResult(null); }
            }}
            className="text-center mt-3"
            style={{
              border: `1.5px dashed ${djDraggingTarget === "rekordbox" ? "var(--led-blue)" : "var(--hw-border-light)"}`,
              borderRadius: 6,
              padding: 18,
              background: djDraggingTarget === "rekordbox" ? "color-mix(in srgb, var(--led-blue) 10%, transparent)" : "transparent",
              transition: "all 0.2s",
            }}
          >
            <span className="font-sans text-[13px]" style={{ color: djDraggingTarget === "rekordbox" ? "var(--led-blue)" : "var(--hw-text-muted)" }}>
              Or drag &amp; drop .xml here
            </span>
          </div>
        </SourceCard>

        {/* ── Serato (coming soon) ── */}
        <SourceCard
          icon={SRC_ICONS.serato}
          title="Serato"
          desc="Import your Serato library"
          disabled
          comingSoon
        />

        {/* ── Local Folder ── */}
        <SourceCard
          icon={SRC_ICONS.agent}
          title="Local Folder"
          desc="Import audio files from a folder on your agent's machine"
        >
          {!selectedAgent ? (
            <p className="font-mono text-[10px]" style={{ color: "var(--hw-text-muted)" }}>
              No agent connected — install the agent first
            </p>
          ) : folderScanResult ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="font-mono" style={{ fontSize: 11, color: "var(--hw-text-secondary)" }}>
                Found <strong style={{ color: "var(--hw-text)" }}>{folderScanResult.total_count}</strong> audio file{folderScanResult.total_count !== 1 ? "s" : ""} in{" "}
                <span style={{ color: "var(--hw-text-dim)" }}>{folderScanResult.path}</span>
              </div>
              <div
                style={{
                  maxHeight: 180,
                  overflowY: "auto",
                  border: "1px solid var(--hw-border-light)",
                  borderRadius: 5,
                  background: "var(--hw-input-bg)",
                }}
              >
                {folderScanResult.files.map((f) => (
                  <div
                    key={f.rel_path}
                    className="font-mono"
                    style={{
                      fontSize: 11,
                      padding: "4px 10px",
                      borderBottom: "1px solid var(--hw-border)",
                      display: "flex",
                      justifyContent: "space-between",
                      color: "var(--hw-text-dim)",
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                      {f.rel_path}
                    </span>
                    <span style={{ marginLeft: 12, flexShrink: 0, color: "var(--hw-text-muted)", textTransform: "uppercase", fontSize: 10 }}>
                      {f.extension}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <ActionButton
                  variant="ghost"
                  onClick={() => { setFolderScanResult(null); setFolderPath(""); }}
                >
                  Cancel
                </ActionButton>
                <ActionButton
                  disabled={folderImporting || folderScanResult.total_count === 0}
                  onClick={async () => {
                    setFolderImporting(true);
                    try {
                      await importFolder(selectedAgent!, folderScanResult!.path);
                      toast.success(`Importing ${folderScanResult!.total_count} tracks — duplicates will be flagged for review`);
                      router.push("/pipeline");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Import failed");
                    } finally {
                      setFolderImporting(false);
                    }
                  }}
                >
                  {folderImporting ? "Importing..." : `Import ${folderScanResult.total_count} Tracks`}
                </ActionButton>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="text"
                  value={folderPath}
                  onChange={(e) => setFolderPath(e.target.value)}
                  placeholder="/Users/you/Music/DJ Sets"
                  className="font-mono"
                  style={{
                    flex: 1,
                    fontSize: 12,
                    padding: "7px 12px",
                    background: "var(--hw-input-bg)",
                    border: "1px solid var(--hw-input-border)",
                    borderRadius: 5,
                    color: "var(--hw-text)",
                    outline: "none",
                  }}
                  onKeyDown={async (e) => {
                    if (e.key === "Enter" && folderPath.trim() && selectedAgent) {
                      setFolderScanning(true);
                      try {
                        const { id } = await sendAgentCommand(selectedAgent, "scan_folder", { path: folderPath.trim() });
                        for (let i = 0; i < 60; i++) {
                          await new Promise((r) => setTimeout(r, 500));
                          const cmd = await getAgentCommandResult(id);
                          if (cmd.status === "completed" && cmd.result) {
                            setFolderScanResult(cmd.result as NonNullable<typeof folderScanResult>);
                            break;
                          }
                          if (cmd.status === "failed") {
                            toast.error(cmd.error ?? "Scan failed");
                            break;
                          }
                        }
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Scan failed");
                      } finally {
                        setFolderScanning(false);
                      }
                    }
                  }}
                />
                <ActionButton
                  variant="outline"
                  onClick={() => setFolderBrowserOpen(true)}
                >
                  Browse
                </ActionButton>
              </div>
              <ActionButton
                disabled={!folderPath.trim() || folderScanning}
                onClick={async () => {
                  if (!folderPath.trim() || !selectedAgent) return;
                  setFolderScanning(true);
                  try {
                    const { id } = await sendAgentCommand(selectedAgent, "scan_folder", { path: folderPath.trim() });
                    for (let i = 0; i < 60; i++) {
                      await new Promise((r) => setTimeout(r, 500));
                      const cmd = await getAgentCommandResult(id);
                      if (cmd.status === "completed" && cmd.result) {
                        setFolderScanResult(cmd.result as NonNullable<typeof folderScanResult>);
                        break;
                      }
                      if (cmd.status === "failed") {
                        toast.error(cmd.error ?? "Scan failed");
                        break;
                      }
                    }
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Scan failed");
                  } finally {
                    setFolderScanning(false);
                  }
                }}
              >
                {folderScanning ? "Scanning..." : "Scan Folder"}
              </ActionButton>
            </div>
          )}
        </SourceCard>

        {folderBrowserOpen && selectedAgent && (
          <FolderBrowser
            agentId={selectedAgent}
            onClose={() => setFolderBrowserOpen(false)}
            onSelect={async (path) => {
              setFolderBrowserOpen(false);
              setFolderPath(path);
            }}
          />
        )}
      </div>

      {/* Loading overlay for import */}
      {loading && (
        <div className="mt-6 flex items-center gap-3">
          <div
            className="w-3 h-3 rounded-full animate-pulse"
            style={{ background: "var(--led-blue)", boxShadow: "0 0 8px var(--led-blue)" }}
          />
          <span className="font-sans text-sm" style={{ color: "var(--led-blue)" }}>
            {trackIdStatus ? "Identifying tracks..." : "Importing..."}
          </span>
        </div>
      )}

      {/* Exportify hint dialog for non-owned playlists */}
      <dialog
        ref={dialogRef}
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 p-0 max-w-md w-full backdrop:bg-black/60"
        style={{
          background: "var(--hw-modal-bg)",
          border: "1px solid var(--hw-border)",
          borderRadius: 12,
        }}
        onClose={() => setShowExportifyHint(false)}
      >
        {showExportifyHint && (
          <div style={{ padding: 24 }}>
            <div className="flex items-center gap-3 mb-4">
              <span
                className="flex items-center justify-center flex-shrink-0"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  background: "var(--hw-warning-bg)",
                  border: "1px solid var(--hw-warning-border)",
                  fontSize: 18,
                }}
              >
                ⚠️
              </span>
              <h2
                className="font-sans font-bold"
                style={{ fontSize: 17, color: "var(--hw-text)" }}
              >
                Can&apos;t read this playlist
              </h2>
            </div>
            <p
              className="font-sans text-[14px]"
              style={{ color: "var(--hw-text-sec)", lineHeight: 1.6, marginBottom: 12 }}
            >
              Spotify doesn&apos;t allow reading tracks from playlists you don&apos;t own via the API.
            </p>
            <p
              className="font-sans text-[13px]"
              style={{ color: "var(--hw-text-dim)", lineHeight: 1.6, marginBottom: 20 }}
            >
              You can export it as a CSV from{" "}
              <a
                href="https://exportify.app"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--led-blue)", textDecoration: "underline" }}
              >
                exportify.app
              </a>{" "}
              and then import it using the <strong style={{ color: "var(--hw-text)" }}>CSV upload</strong> option above.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  dialogRef.current?.close();
                  setSelectedPlaylistId(null);
                }}
                className="font-sans text-[13px] cursor-pointer"
                style={{
                  color: "var(--hw-text-dim)",
                  background: "none",
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: 6,
                }}
              >
                Deselect playlist
              </button>
              <button
                onClick={() => dialogRef.current?.close()}
                className="font-mono text-[11px] font-bold cursor-pointer"
                style={{
                  letterSpacing: 0.5,
                  background: "var(--led-blue)",
                  color: "#fff",
                  border: "none",
                  padding: "8px 20px",
                  borderRadius: 6,
                }}
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: REVIEW TRACKS
// ═══════════════════════════════════════════════════════════════════════════════

interface Step2Props {
  candidates: Track[];
  onSelectedChange: (count: number) => void;
  onBack: () => void;
  onComplete: () => void;
}

function Step2Review({ candidates, onSelectedChange, onBack: _onBack, onComplete }: Step2Props) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const t of candidates) {
      const key = (t as unknown as PreviewTrack)._key ?? String(t.id);
      initial[key] = !t.already_owned;
    }
    return initial;
  });
  const [loading, setLoading] = useState(false);

  const alreadyOwnedKeys = new Set(
    candidates.filter((t) => t.already_owned).map((t) =>
      (t as unknown as PreviewTrack)._key ?? String(t.id)
    )
  );

  const filtered = candidates.filter((t) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (t.title ?? "").toLowerCase().includes(q) ||
      (t.artist ?? "").toLowerCase().includes(q)
    );
  });

  const selectedCount = Object.values(selected).filter(Boolean).length;
  const ownedCount = candidates.filter((t) => t.already_owned).length;
  const allSelected = filtered.length > 0 && filtered.every((t) => {
    const key = (t as unknown as PreviewTrack)._key ?? String(t.id);
    return selected[key];
  });

  // Notify parent of selection count
  useEffect(() => {
    onSelectedChange(selectedCount);
  }, [selectedCount, onSelectedChange]);

  function toggleAll() {
    const newVal = !allSelected;
    setSelected((prev) => {
      const next = { ...prev };
      for (const t of filtered) {
        const key = (t as unknown as PreviewTrack)._key ?? String(t.id);
        next[key] = newVal;
      }
      return next;
    });
  }

  async function handleConfirm() {
    const toDownload = candidates.filter((t) => {
      const key = (t as unknown as PreviewTrack)._key ?? String(t.id);
      return selected[key];
    }) as unknown as PreviewTrack[];

    if (toDownload.length === 0) return;
    setLoading(true);
    try {
      await confirmImport(toDownload, true);
      onComplete();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to queue downloads");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: "clamp(24px, 4vw, 40px)" }}>
      <h2
        className="font-sans font-black"
        style={{ fontSize: "clamp(24px, 3.5vw, 32px)", letterSpacing: -1, marginBottom: 8 }}
      >
        Confirm your download list
      </h2>
      <p
        className="font-sans text-[15px]"
        style={{ color: "var(--hw-text-sec)", marginBottom: 28, lineHeight: 1.6 }}
      >
        Deselect any tracks you don&apos;t want. Already-owned tracks are excluded automatically.
      </p>

      {/* Hidden button for sticky footer trigger */}
      <button id="step2-confirm-btn" onClick={handleConfirm} className="hidden" />

      {/* LCD Stats */}
      <div className="grid grid-cols-3 gap-2.5 mb-6">
        <LCDDisplay value={selectedCount} label="To download" />
        <LCDDisplay value={ownedCount} label="Already owned" />
        <LCDDisplay value={candidates.length} label="Total imported" />
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search by title or artist..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full font-sans text-sm outline-none transition-all duration-200 mb-3.5"
        style={{
          color: "var(--hw-text)",
          background: "var(--hw-input-bg)",
          border: "1.5px solid var(--hw-input-border)",
          borderRadius: 6,
          padding: "12px 16px",
        }}
        onFocus={(e) => {
          e.target.style.borderColor = "color-mix(in srgb, var(--led-blue) 35%, transparent)";
          e.target.style.boxShadow = "0 0 0 3px color-mix(in srgb, var(--led-blue) 7%, transparent)";
        }}
        onBlur={(e) => {
          e.target.style.borderColor = "var(--hw-input-border)";
          e.target.style.boxShadow = "none";
        }}
      />

      {/* Track list */}
      <div
        className="overflow-hidden"
        style={{
          border: "1px solid var(--hw-border-light)",
          borderRadius: 6,
          maxHeight: 420,
          overflowY: "auto",
        }}
      >
        {/* Header */}
        <div
          className="grid items-center sticky top-0 z-10"
          style={{
            gridTemplateColumns: "28px 44px 32px 2fr 1.5fr 1fr",
            padding: "10px 16px",
            gap: 12,
            background: "var(--hw-raised)",
            borderBottom: "1px solid var(--hw-border-light)",
          }}
        >
          <Checkbox
            checked={allSelected}
            onChange={() => toggleAll()}
          />
          <span />
          <span />
          <span className="font-mono text-[9px] font-bold uppercase" style={{ color: "var(--hw-text-dim)", letterSpacing: 1.5 }}>
            TRACK
          </span>
          <span className="font-mono text-[9px] font-bold uppercase" style={{ color: "var(--hw-text-dim)", letterSpacing: 1.5 }}>
            ARTIST
          </span>
          <span className="font-mono text-[9px] font-bold uppercase text-right" style={{ color: "var(--hw-text-dim)", letterSpacing: 1.5 }}>
            STATUS
          </span>
        </div>

        {filtered.map((t) => {
          const tKey = (t as unknown as PreviewTrack)._key ?? String(t.id);
          return (
            <TrackReviewRow
              key={tKey}
              track={t}
              isSelected={selected[tKey]}
              isOwned={alreadyOwnedKeys.has(tKey)}
              onToggle={() => setSelected((p) => ({ ...p, [tKey]: !p[tKey] }))}
            />
          );
        })}
      </div>

      {loading && (
        <div className="mt-4 flex items-center gap-3">
          <div
            className="w-3 h-3 rounded-full animate-pulse"
            style={{ background: "var(--led-blue)", boxShadow: "0 0 8px var(--led-blue)" }}
          />
          <span className="font-sans text-sm" style={{ color: "var(--led-blue)" }}>Queuing downloads...</span>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: DOWNLOAD AGENT
// ═══════════════════════════════════════════════════════════════════════════════

interface Step3Props {
  apiKey: string;
  setApiKey: (key: string) => void;
  machineName: string;
  onAgentChange: (connected: boolean) => void;
  onDone: () => void;
}

function Step3Agent({ apiKey, setApiKey, machineName, onAgentChange, onDone: _onDone }: Step3Props) {
  const [agentConnected, setAgentConnected] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [pendingJobs, setPendingJobs] = useState<number | null>(null);
  const [pollErrors, setPollErrors] = useState(0);
  const [registering, setRegistering] = useState(!apiKey);
  const _supabase = createClient();

  useEffect(() => {
    if (apiKey) return;
    fetchAgents()
      .then((agents) => {
        const existing = agents.find((a) => a.machine_name === machineName);
        if (existing) {
          setRegistering(false);
          return;
        }
        return registerAgent(machineName)
          .then((result) => setApiKey(result.api_key));
      })
      .catch(() => toast.error("Failed to generate API key. Please try again."))
      .finally(() => setRegistering(false));
  }, [apiKey, machineName, setApiKey]);

  useEffect(() => {
    if (agentConnected) return;
    const interval = setInterval(async () => {
      try {
        const agents = await fetchAgents();
        const now = Date.now();
        const live = agents.find(
          (a) =>
            a.last_seen_at &&
            now - new Date(a.last_seen_at).getTime() < 60_000
        );
        if (live) {
          setAgentConnected(true);
          onAgentChange(true);
          setAgentName(live.machine_name ?? "your Mac");
          setPollErrors(0);
          fetchPipelineStatus()
            .then((s) => setPendingJobs(s.pending))
            .catch(() => {});
        }
      } catch {
        setPollErrors((e) => e + 1);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [agentConnected, onAgentChange]);

  const statusState =
    agentConnected ? "connected" : pollErrors >= 3 ? "error" : "waiting";

  return (
    <div style={{ padding: "clamp(24px, 4vw, 40px)" }}>
      <h2
        className="font-sans font-black"
        style={{ fontSize: "clamp(24px, 3.5vw, 32px)", letterSpacing: -1, marginBottom: 8 }}
      >
        Install the djtoolkit agent
      </h2>
      <p
        className="font-sans text-[15px]"
        style={{ color: "var(--hw-text-sec)", marginBottom: 32, lineHeight: 1.6, maxWidth: 520 }}
      >
        The agent runs on your Mac and handles downloading, fingerprinting, and tagging
        — your files never leave your machine.
      </p>

      <div className="flex flex-col gap-3.5">
        {/* Desktop App (recommended) */}
        <SourceCard
          icon={SRC_ICONS.homebrew}
          title="Desktop App"
          desc="Menu bar app with setup wizard and auto-updates. The app will guide you through setup automatically."
          active
        >
          <span
            className="font-mono text-[10px] font-bold uppercase inline-block mb-3"
            style={{
              color: "var(--hw-success-text)",
              background: "var(--hw-success-bg)",
              border: "1px solid var(--hw-success-border)",
              padding: "3px 10px",
              borderRadius: 4,
              letterSpacing: 1,
            }}
          >
            recommended
          </span>
          <CopyBlock text="brew tap yenkz/djtoolkit && brew install --cask djtoolkit" />
          <div className="mt-3 flex items-center gap-3">
            <a
              href="https://github.com/yenkz/djtoolkit/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
            >
              <ActionButton variant="outline">GitHub Releases</ActionButton>
            </a>
            <span
              className="font-sans text-xs"
              style={{ color: "var(--hw-text-dim)" }}
            >
              or{" "}
              <code
                className="font-mono"
                style={{ fontSize: 11, color: "var(--hw-text-dim)" }}
              >
                curl -fsSL https://raw.githubusercontent.com/yenkz/djtoolkit/main/install.sh | bash
              </code>
            </span>
          </div>
        </SourceCard>

        {/* CLI (power users) */}
        <SourceCard
          icon={SRC_ICONS.download}
          title="CLI"
          desc="Terminal-based install for power users."
        >
          <span
            className="font-mono text-[10px] font-bold uppercase inline-block mb-3"
            style={{
              color: "var(--hw-steel-text, #8A9AAA)",
              background: "rgba(138,154,170,0.1)",
              border: "1px solid rgba(138,154,170,0.2)",
              padding: "3px 10px",
              borderRadius: 4,
              letterSpacing: 1,
            }}
          >
            for power users
          </span>
          <CopyBlock text="brew tap yenkz/djtoolkit && brew install djtoolkit" />
        </SourceCard>
      </div>

      {/* CLI setup */}
      <div className="mt-7">
        <div
          className="font-mono text-[10px] font-bold uppercase mb-1.5"
          style={{ color: "var(--hw-text-dim)", letterSpacing: 1.5 }}
        >
          CLI setup
        </div>
        <p
          className="font-sans text-xs mb-2.5"
          style={{ color: "var(--hw-text-dim)" }}
        >
          If you installed the desktop app, skip this — the app handles setup automatically.
        </p>
        {registering || !apiKey ? (
          <div className="font-sans text-sm py-2" style={{ color: "var(--hw-text-dim)" }}>
            Generating API key...
          </div>
        ) : (
          <>
            <CopyBlock text={`djtoolkit agent configure --api-key ${apiKey}`} />
            <CopyBlock text="djtoolkit agent install" />
            <CopyBlock text="djtoolkit agent start" />
          </>
        )}
      </div>

      {/* Status indicator */}
      <div
        className="flex items-center gap-4 mt-6 mb-6"
        style={{
          border: `1.5px solid ${
            statusState === "connected"
              ? "var(--hw-success-border)"
              : statusState === "error"
              ? "var(--hw-warning-border)"
              : "var(--hw-border)"
          }`,
          background:
            statusState === "connected"
              ? "var(--hw-success-bg)"
              : statusState === "error"
              ? "var(--hw-warning-bg)"
              : "var(--hw-surface)",
          borderRadius: 8,
          padding: "18px 22px",
        }}
      >
        <div
          className="flex-shrink-0"
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background:
              statusState === "connected"
                ? "var(--led-green)"
                : statusState === "error"
                ? "var(--led-orange)"
                : "var(--led-red)",
            boxShadow:
              statusState === "connected"
                ? "0 0 8px color-mix(in srgb, var(--led-green) 40%, transparent)"
                : statusState === "error"
                ? "0 0 8px color-mix(in srgb, var(--led-orange) 40%, transparent)"
                : "0 0 8px color-mix(in srgb, var(--led-red) 40%, transparent)",
          }}
        />
        <div>
          {statusState === "connected" ? (
            <>
              <div className="font-sans text-base font-bold" style={{ color: "var(--hw-text)" }}>
                Agent connected — {agentName}
              </div>
              <div className="font-sans text-[13px] mt-0.5" style={{ color: "var(--hw-success-text)" }}>
                {pendingJobs !== null ? `${pendingJobs} download jobs queued and ready` : ""}
              </div>
            </>
          ) : statusState === "error" ? (
            <div className="font-sans text-sm" style={{ color: "var(--hw-warning-text)" }}>
              Connection check failed — retrying...
            </div>
          ) : (
            <>
              <div className="font-sans text-sm" style={{ color: "var(--hw-text)" }}>
                Agent not connected
              </div>
              <div className="font-sans text-xs" style={{ color: "var(--hw-text-dim)" }}>
                Checking every 5s...
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
