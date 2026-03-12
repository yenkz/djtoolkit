"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  fetchSpotifyPlaylists,
  importSpotifyPlaylistNoJobs,
  importCsvNoJobs,
  fetchCandidateTracks,
  bulkCreateJobs,
  bulkDeleteTracks,
  fetchAgents,
  fetchPipelineStatus,
  registerAgent,
  type Track,
} from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

type Step = 1 | 2 | 3;

const STEP_LABELS = ["Import", "Review", "Download Agent"] as const;

function StepBar({ current }: { current: Step }) {
  return (
    <div className="flex border-b border-gray-800">
      {STEP_LABELS.map((label, i) => {
        const stepNum = (i + 1) as Step;
        const isDone = stepNum < current;
        const isActive = stepNum === current;
        return (
          <div
            key={label}
            className={`flex-1 py-3.5 text-center text-xs font-semibold tracking-widest uppercase border-b-2 transition-colors ${
              isActive
                ? "text-indigo-400 border-indigo-500"
                : isDone
                ? "text-green-400 border-transparent"
                : "text-gray-600 border-transparent"
            }`}
          >
            {isDone ? `✓ ${label}` : `${stepNum} · ${label}`}
          </div>
        );
      })}
    </div>
  );
}

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>(1);
  const [candidates, setCandidates] = useState<Track[]>([]);
  const [apiKey, setApiKey] = useState<string>("");
  const [machineName] = useState("My Mac");
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <div className="flex flex-col min-h-screen">
      <StepBar current={step} />
      <div className="flex-1 overflow-y-auto">
        {step === 1 && (
          <Step1Import
            searchParams={searchParams}
            onComplete={(tracks) => {
              setCandidates(tracks);
              setStep(2);
            }}
          />
        )}
        {step === 2 && (
          <Step2Review
            candidates={candidates}
            onBack={() => setStep(1)}
            onComplete={() => setStep(3)}
          />
        )}
        {step === 3 && (
          <Step3Agent
            apiKey={apiKey}
            setApiKey={setApiKey}
            machineName={machineName}
            onDone={() => router.push("/pipeline")}
          />
        )}
      </div>
    </div>
  );
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const SESSION_KEY = "djtoolkit_onboarding_state";

interface Step1Props {
  searchParams: ReturnType<typeof useSearchParams>;
  onComplete: (tracks: Track[]) => void;
}

function Step1Import({ searchParams, onComplete }: Step1Props) {
  const [playlists, setPlaylists] = useState<
    { id: string; name: string; track_count: number }[]
  >([]);
  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvRowCount, setCsvRowCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);

  const loadPlaylists = useCallback(async () => {
    try {
      const data = await fetchSpotifyPlaylists();
      setPlaylists(data);
      setSpotifyConnected(true);
    } catch {
      setSpotifyConnected(false);
    }
  }, []);

  useEffect(() => {
    loadPlaylists();
    if (searchParams.get("spotify") === "connected") {
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
  const totalTracks = (selectedPlaylist?.track_count ?? 0) + csvRowCount;
  const sourcesSelected = (selectedPlaylistId ? 1 : 0) + (csvFile ? 1 : 0);

  async function handleContinue() {
    if (!selectedPlaylistId && !csvFile) return;
    setLoading(true);
    try {
      const calls: Promise<unknown>[] = [];
      if (selectedPlaylistId) calls.push(importSpotifyPlaylistNoJobs(selectedPlaylistId));
      if (csvFile) calls.push(importCsvNoJobs(csvFile));
      await Promise.all(calls);
      const tracks = await fetchCandidateTracks();
      onComplete(tracks);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  function handleSpotifyConnect() {
    if (csvFile) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ csvName: csvFile.name }));
    }
    window.location.href = `${API_URL}/api/auth/spotify/connect?return_to=/onboarding`;
  }

  return (
    <div className="max-w-lg mx-auto px-6 py-10">
      <h1 className="text-xl font-bold text-white mb-1">Where&apos;s your music coming from?</h1>
      <p className="text-sm text-gray-500 mb-7">
        You can import from multiple sources — all tracks will be combined in step 2.
      </p>

      {/* Spotify card */}
      <div
        className={`border rounded-xl p-4 mb-3 ${
          spotifyConnected ? "border-indigo-500 bg-indigo-950/40" : "border-gray-700 bg-gray-900"
        }`}
      >
        <div className="flex items-center gap-3 mb-3">
          <span className="text-2xl">🎵</span>
          <div className="flex-1">
            <div className="text-sm font-bold text-white">Spotify</div>
            {spotifyConnected ? (
              <div className="text-xs text-indigo-400">Connected</div>
            ) : (
              <div className="text-xs text-gray-500">Connect your Spotify account</div>
            )}
          </div>
          {spotifyConnected ? (
            <span className="text-xs bg-green-900 text-green-300 px-2 py-0.5 rounded font-semibold">
              ✓ Connected
            </span>
          ) : (
            <button
              onClick={handleSpotifyConnect}
              className="text-xs border border-indigo-500 text-indigo-400 px-3 py-1.5 rounded-lg hover:bg-indigo-900/30"
            >
              Connect Spotify
            </button>
          )}
        </div>
        {spotifyConnected && playlists.length > 0 && (
          <div className="bg-gray-950 border border-indigo-900 rounded-lg overflow-hidden">
            <div className="px-3 py-2 text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
              Select playlist
            </div>
            {playlists.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedPlaylistId(p.id === selectedPlaylistId ? null : p.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-left border-b border-gray-800 last:border-0 transition-colors ${
                  selectedPlaylistId === p.id ? "bg-indigo-950/60" : "hover:bg-gray-900"
                }`}
              >
                <div
                  className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${
                    selectedPlaylistId === p.id
                      ? "bg-indigo-500 border-indigo-500"
                      : "border-gray-600"
                  }`}
                />
                <span className="flex-1 text-sm text-white">{p.name}</span>
                <span className="text-xs text-gray-500">{p.track_count} tracks</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* CSV card */}
      <div className="border border-gray-700 rounded-xl p-4 mb-3 bg-gray-900">
        <div className="flex items-center gap-3">
          <span className="text-2xl">📄</span>
          <div className="flex-1">
            <div className="text-sm font-bold text-white">Exported Spotify Playlist (CSV)</div>
            <div className="text-xs text-gray-500">Upload a CSV exported from exportify.app</div>
          </div>
          <button
            onClick={() => document.getElementById("csv-upload")?.click()}
            className="text-xs border border-gray-600 text-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-800"
          >
            {csvFile ? "Change" : "Upload file"}
          </button>
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
          <div className="mt-3 text-xs text-green-400">✓ {csvFile.name} ({csvRowCount} tracks)</div>
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
          className={`mt-3 border-2 border-dashed rounded-lg p-4 text-center text-xs transition-colors ${
            dragging ? "border-indigo-500 bg-indigo-900/20 text-indigo-300" : "border-gray-700 text-gray-600"
          }`}
        >
          Or drag &amp; drop CSV here
        </div>
      </div>

      {/* TrackID — coming soon */}
      <div className="border border-gray-800 rounded-xl p-4 mb-8 bg-gray-950 opacity-40">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🎧</span>
          <div className="flex-1">
            <div className="text-sm font-bold text-gray-400">TrackID</div>
            <div className="text-xs text-gray-600">
              Identify tracks from a YouTube, SoundCloud, or Mixcloud set
            </div>
          </div>
          <span className="text-xs bg-gray-800 text-gray-600 px-2 py-0.5 rounded">
            Coming soon
          </span>
        </div>
      </div>

      {/* CTA */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-500">
          {sourcesSelected > 0
            ? `${sourcesSelected} source${sourcesSelected > 1 ? "s" : ""} selected · ${totalTracks} tracks`
            : "Select at least one source"}
        </span>
        <button
          onClick={handleContinue}
          disabled={totalTracks === 0 || loading}
          className="bg-indigo-600 text-white text-sm font-semibold px-6 py-2.5 rounded-lg hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? "Importing…" : "Review tracks →"}
        </button>
      </div>
    </div>
  );
}
