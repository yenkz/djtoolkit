"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  fetchSpotifyPlaylists,
  importSpotifyPlaylistNoJobs,
  importCsvNoJobs,
  submitTrackIdJob,
  getTrackIdJobStatus,
  fetchTracksByIds,
  bulkCreateJobs,
  bulkDeleteTracks,
  fetchAgents,
  fetchPipelineStatus,
  registerAgent,
  disconnectSpotify,
  type Track,
  type TrackIdJobStatus,
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

const API_URL = "";
const SESSION_KEY = "djtoolkit_onboarding_state";

interface Step1Props {
  searchParams: ReturnType<typeof useSearchParams>;
  onComplete: (tracks: Track[]) => void;
}

function Step1Import({ searchParams, onComplete }: Step1Props) {
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

  const loadPlaylists = useCallback(async () => {
    try {
      const data = await fetchSpotifyPlaylists();
      setPlaylists(data);
      setSpotifyConnected(true);
    } catch (err: unknown) {
      setSpotifyConnected(false);
      // Only show error if we expected to be connected
      if (err instanceof Error && !err.message.includes("not connected")) {
        toast.error(`Couldn't load playlists: ${err.message}`);
      }
    }
  }, []);

  useEffect(() => {
    const isReturningFromSpotify = searchParams.get("spotify") === "connected";
    if (isReturningFromSpotify) {
      toast.success("Spotify connected! Loading your playlists…");
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
  const trackIdValid = /youtu\.?be/.test(trackIdUrl) || trackIdUrl.includes("youtube.com/watch");
  const sourcesSelected = (selectedPlaylistId ? 1 : 0) + (csvFile ? 1 : 0) + (trackIdValid ? 1 : 0);

  async function handleContinue() {
    if (sourcesSelected === 0) return;
    setLoading(true);
    setTrackIdStatus(null);
    try {
      // Run Spotify + CSV in parallel (fast, no progress needed)
      const parallelCalls: Promise<{ track_ids: number[] }>[] = [];
      if (selectedPlaylistId) parallelCalls.push(importSpotifyPlaylistNoJobs(selectedPlaylistId));
      if (csvFile) parallelCalls.push(importCsvNoJobs(csvFile));
      const parallelResults = await Promise.all(parallelCalls);

      // Submit TrackID job and poll for progress
      let trackIdIds: number[] = [];
      if (trackIdValid) {
        const { job_id } = await submitTrackIdJob(trackIdUrl);

        // Poll until completed or failed
        while (true) {
          await new Promise((r) => setTimeout(r, 2000));
          const s = await getTrackIdJobStatus(job_id);
          setTrackIdStatus(s);
          if (s.status === "completed") {
            if (s.result!.imported === 0) {
              toast.warning("TrackID found no identifiable tracks in this mix.");
              if (!selectedPlaylistId && !csvFile) {
                setLoading(false);
                setTrackIdStatus(null);
                return;
              }
            }
            trackIdIds = s.result!.track_ids;
            break;
          }
          if (s.status === "failed") {
            throw new Error(s.error ?? "TrackID job failed");
          }
        }
      }

      const allImportedIds = [
        ...parallelResults.flatMap((r) => r.track_ids),
        ...trackIdIds,
      ];
      const tracks = await fetchTracksByIds(allImportedIds);
      onComplete(tracks);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Import failed");
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
            <div className="flex items-center gap-2">
              <span className="text-xs bg-green-900 text-green-300 px-2 py-0.5 rounded font-semibold">
                ✓ Connected
              </span>
              <button
                onClick={handleSpotifyDisconnect}
                className="text-xs text-gray-500 hover:text-red-400 transition-colors"
              >
                Disconnect
              </button>
            </div>
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
            <div className="max-h-64 overflow-y-auto">
            {playlists.map((p) => {
              const isSpotifyCurated = p.owner?.toLowerCase() === "spotify";
              const isNotOwned = p.is_owner === false && !isSpotifyCurated;
              const isDisabled = isSpotifyCurated;
              return (
                <button
                  key={p.id}
                  onClick={() => !isDisabled && setSelectedPlaylistId(p.id === selectedPlaylistId ? null : p.id)}
                  disabled={isDisabled}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-left border-b border-gray-800 last:border-0 transition-colors ${
                    isDisabled
                      ? "opacity-40 cursor-not-allowed"
                      : selectedPlaylistId === p.id
                      ? "bg-indigo-950/60"
                      : "hover:bg-gray-900"
                  }`}
                >
                  <div
                    className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${
                      selectedPlaylistId === p.id
                        ? "bg-indigo-500 border-indigo-500"
                        : "border-gray-600"
                    }`}
                  />
                  {p.image_url ? (
                    <img src={p.image_url} alt="" className="w-8 h-8 rounded flex-shrink-0 object-cover" />
                  ) : (
                    <div className="w-8 h-8 rounded flex-shrink-0 bg-gray-800" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white truncate">{p.name}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {p.owner ? `by ${p.owner}` : ""}
                      {isSpotifyCurated && <span className="ml-1 text-gray-600">(can&apos;t import via API)</span>}
                      {isNotOwned && <span className="ml-1 text-yellow-700">· may be restricted</span>}
                    </div>
                  </div>
                  <span className="text-xs text-gray-500 flex-shrink-0">
                    {p.track_count != null ? `${p.track_count} tracks` : "—"}
                  </span>
                </button>
              );
            })}
            </div>
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

      {/* TrackID */}
      <div className={`border rounded-xl p-4 mb-8 ${trackIdValid ? "border-indigo-500 bg-indigo-950/40" : "border-gray-700 bg-gray-900"}`}>
        <div className="flex items-center gap-3 mb-3">
          <span className="text-2xl">🎧</span>
          <div className="flex-1">
            <div className="text-sm font-bold text-white">TrackID</div>
            <div className="text-xs text-gray-500">
              Identify tracks from a YouTube DJ set or mix
            </div>
          </div>
          {trackIdValid && (
            <span className="text-xs bg-green-900 text-green-300 px-2 py-0.5 rounded font-semibold">
              ✓ URL set
            </span>
          )}
        </div>
        <input
          type="url"
          placeholder="https://www.youtube.com/watch?v=..."
          value={trackIdUrl}
          onChange={(e) => setTrackIdUrl(e.target.value)}
          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
        />
        {trackIdValid && !trackIdStatus && (
          <p className="mt-2 text-xs text-yellow-500">
            Track identification runs during import and may take a few minutes.
          </p>
        )}
        {trackIdStatus && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-indigo-300">{trackIdStatus.step}</span>
              <span className="text-xs text-gray-500">{trackIdStatus.progress}%</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-1.5">
              <div
                className="bg-indigo-500 h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${trackIdStatus.progress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* CTA */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-500">
          {sourcesSelected > 0
            ? `${sourcesSelected} source${sourcesSelected > 1 ? "s" : ""} selected` +
              (totalTracks > 0 ? ` · ${totalTracks} tracks` : "") +
              (trackIdValid ? " + YouTube mix" : "")
            : "Select at least one source"}
        </span>
        <button
          onClick={handleContinue}
          disabled={sourcesSelected === 0 || loading}
          className="bg-indigo-600 text-white text-sm font-semibold px-6 py-2.5 rounded-lg hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {trackIdStatus && loading
            ? "Identifying tracks…"
            : loading
            ? "Importing…"
            : "Review tracks →"}
        </button>
      </div>
    </div>
  );
}

interface Step2Props {
  candidates: Track[];
  onBack: () => void;
  onComplete: () => void;
}

function Step2Review({ candidates, onBack, onComplete }: Step2Props) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<number, boolean>>(() => {
    const initial: Record<number, boolean> = {};
    for (const t of candidates) {
      initial[t.id] = !t.already_owned;
    }
    return initial;
  });
  const [loading, setLoading] = useState(false);

  const alreadyOwnedIds = new Set(candidates.filter((t) => t.already_owned).map((t) => t.id));

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
  const allSelected = filtered.length > 0 && filtered.every((t) => selected[t.id]);

  function toggleAll() {
    const newVal = !allSelected;
    setSelected((prev) => {
      const next = { ...prev };
      for (const t of filtered) next[t.id] = newVal;
      return next;
    });
  }

  async function handleConfirm() {
    const toDownload = candidates.filter((t) => selected[t.id]).map((t) => t.id);
    const toDelete = candidates
      .filter((t) => !selected[t.id] && !alreadyOwnedIds.has(t.id))
      .map((t) => t.id);

    if (toDownload.length === 0) return;
    setLoading(true);
    try {
      await Promise.all([
        bulkCreateJobs(toDownload),
        toDelete.length > 0 ? bulkDeleteTracks(toDelete) : Promise.resolve(),
      ]);
      onComplete();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to queue downloads");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <h1 className="text-xl font-bold text-white mb-1">Confirm your download list</h1>
      <p className="text-sm text-gray-500 mb-5">
        Deselect any tracks you don&apos;t want. Already-owned tracks are excluded automatically.
      </p>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        {[
          { label: "To download", value: selectedCount },
          { label: "Already owned", value: ownedCount },
          { label: "Total imported", value: candidates.length },
        ].map(({ label, value }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-white">{value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search by title or artist…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 mb-2 focus:outline-none focus:border-indigo-500"
      />

      {/* Select all */}
      <div className="flex items-center gap-2.5 px-3 py-2 bg-gray-800 rounded-t-lg border-b border-gray-900">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={toggleAll}
          className="w-3.5 h-3.5 accent-indigo-500"
        />
        <span className="text-xs text-gray-300 font-semibold flex-1">Select all</span>
        <span className="text-xs text-gray-500">{selectedCount} selected</span>
      </div>

      {/* Track list */}
      <div
        className="border border-gray-800 border-t-0 rounded-b-lg overflow-y-auto"
        style={{ maxHeight: "calc(100vh - 420px)" }}
      >
        {filtered.map((t) => {
          const isOwned = alreadyOwnedIds.has(t.id);
          const isSelected = selected[t.id];
          return (
            <div
              key={t.id}
              onClick={() => setSelected((p) => ({ ...p, [t.id]: !p[t.id] }))}
              className={`flex items-center gap-3 px-3 py-2.5 border-b border-gray-900 last:border-0 cursor-pointer transition-colors ${
                isSelected ? "bg-gray-900 hover:bg-gray-800/60" : "bg-gray-950 opacity-50"
              }`}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => {}}
                className="w-3.5 h-3.5 accent-indigo-500 flex-shrink-0"
                onClick={(e) => e.stopPropagation()}
              />
              <div className="flex-1 min-w-0">
                <span
                  className={`text-sm ${isSelected ? "text-white" : "text-gray-500 line-through"}`}
                >
                  {t.title}
                </span>
              </div>
              <div className="w-40 text-xs text-gray-500 truncate">{t.artist}</div>
              {isOwned && (
                <span className="text-xs bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded flex-shrink-0">
                  Already owned
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* CTA */}
      <div className="flex items-center justify-between mt-5">
        <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-300">
          ← Back
        </button>
        <button
          onClick={handleConfirm}
          disabled={selectedCount === 0 || loading}
          className="bg-indigo-600 text-white text-sm font-semibold px-6 py-2.5 rounded-lg hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? "Queuing…" : `Queue ${selectedCount} download${selectedCount !== 1 ? "s" : ""} →`}
        </button>
      </div>
    </div>
  );
}

// CopyBlock is defined at module scope so it doesn't remount on every render
function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-gray-950 border border-gray-800 rounded-lg px-4 py-2.5 flex items-center justify-between gap-3 mb-2">
      <code className="text-green-300 text-xs font-mono break-all">{text}</code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="text-xs text-gray-500 hover:text-white flex-shrink-0"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

interface Step3Props {
  apiKey: string;
  setApiKey: (key: string) => void;
  machineName: string;
  onDone: () => void;
}

function Step3Agent({ apiKey, setApiKey, machineName, onDone }: Step3Props) {
  const [agentConnected, setAgentConnected] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [pendingJobs, setPendingJobs] = useState<number | null>(null);
  const [pollErrors, setPollErrors] = useState(0);
  const [registering, setRegistering] = useState(!apiKey);
  const supabase = createClient();

  useEffect(() => {
    if (apiKey) return;
    // Check if an agent already exists before registering a new one
    fetchAgents()
      .then((agents) => {
        const existing = agents.find((a) => a.machine_name === machineName);
        if (existing) {
          // Agent already registered — skip registration, just poll for connection
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
          setAgentName(live.machine_name ?? "your Mac");
          setPollErrors(0);
          fetchPipelineStatus()
            .then((s) => setPendingJobs(s.pending))
            .catch(() => {});
        } else {
          // No live agent found — don't reset error counter
        }
      } catch {
        setPollErrors((e) => e + 1);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [agentConnected]);

  async function handleDone() {
    await supabase.auth.updateUser({
      data: { onboarding_completed: true },
    });
    onDone();
  }

  const statusState =
    agentConnected ? "connected" : pollErrors >= 3 ? "error" : "waiting";

  return (
    <div className="max-w-lg mx-auto px-6 py-10">
      <h1 className="text-xl font-bold text-white mb-1">Install the djtoolkit agent</h1>
      <p className="text-sm text-gray-500 mb-6">
        The agent runs on your Mac and handles downloading, fingerprinting, and tagging
        — your files never leave your machine.
      </p>

      {/* Homebrew (recommended) */}
      <div className="border border-indigo-500 bg-indigo-950/30 rounded-xl p-4 mb-3">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-2xl">🍺</span>
          <div className="flex-1">
            <div className="text-sm font-bold text-white">Homebrew <span className="text-xs font-normal text-indigo-400 ml-1">recommended</span></div>
            <div className="text-xs text-indigo-300">Automatic updates &middot; includes all dependencies</div>
          </div>
        </div>
        <CopyBlock text="brew tap yenkz/djtoolkit && brew install djtoolkit" />
      </div>

      {/* Direct download */}
      <div className="border border-gray-700 bg-gray-900 rounded-xl p-4 mb-3 flex items-center gap-3">
        <span className="text-2xl">💿</span>
        <div className="flex-1">
          <div className="text-sm font-bold text-white">Direct download</div>
          <div className="text-xs text-gray-500">macOS .dmg &middot; arm64 + x86_64</div>
        </div>
        <a
          href="https://github.com/yenkz/djtoolkit/releases/latest"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-gray-700 text-white text-xs font-semibold px-4 py-2 rounded-lg hover:bg-gray-600"
        >
          GitHub Releases
        </a>
      </div>

      {/* pip alternative */}
      <div className="mb-5">
        <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Or install via pip</div>
        <CopyBlock text="pip install djtoolkit" />
      </div>

      {/* Configure + start */}
      <div className="mb-6">
        <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">
          Configure &amp; start
        </div>
        {registering || !apiKey ? (
          <div className="text-xs text-gray-500 py-2">Generating API key…</div>
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
        className={`border rounded-lg px-4 py-3 flex items-center gap-3 mb-5 ${
          statusState === "connected"
            ? "border-green-700 bg-green-950/30"
            : statusState === "error"
            ? "border-yellow-700 bg-yellow-950/20"
            : "border-gray-700 bg-gray-900"
        }`}
      >
        <div
          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
            statusState === "connected"
              ? "bg-green-500 shadow-[0_0_8px_2px_rgba(34,197,94,0.5)]"
              : statusState === "error"
              ? "bg-yellow-400 shadow-[0_0_8px_2px_rgba(250,204,21,0.4)]"
              : "bg-red-500 shadow-[0_0_8px_2px_rgba(239,68,68,0.4)]"
          }`}
        />
        <div>
          {statusState === "connected" ? (
            <>
              <div className="text-sm font-semibold text-green-300">
                Agent connected — {agentName}
              </div>
              <div className="text-xs text-green-700">
                {pendingJobs !== null ? `${pendingJobs} download jobs queued and ready` : ""}
              </div>
            </>
          ) : statusState === "error" ? (
            <div className="text-sm text-yellow-300">Connection check failed — retrying…</div>
          ) : (
            <>
              <div className="text-sm text-gray-300">Agent not connected</div>
              <div className="text-xs text-gray-600">Checking every 5s…</div>
            </>
          )}
        </div>
      </div>

      {/* CTAs */}
      <div className="flex flex-col items-end gap-2">
        <button
          onClick={handleDone}
          disabled={!agentConnected}
          className={`text-sm font-bold px-6 py-2.5 rounded-lg transition-colors ${
            agentConnected
              ? "bg-green-600 text-white hover:bg-green-500"
              : "bg-gray-800 text-gray-600 cursor-not-allowed"
          }`}
        >
          Go to Pipeline →
        </button>
        <button
          onClick={() => { window.location.href = "/catalog"; }}
          className="text-xs text-gray-600 hover:text-gray-400"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
