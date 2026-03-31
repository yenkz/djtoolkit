"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  disconnectSpotify,
  fetchSettings,
  updateSettings,
  clearLibrary,
  deleteAccount,
  type UserSettings,
} from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { useTheme } from "@/lib/theme-provider";

import SectionNav from "@/components/ui/SectionNav";
import Section from "@/components/ui/Section";
import TextInput from "@/components/ui/TextInput";
import NumberInput from "@/components/ui/NumberInput";
import Toggle from "@/components/ui/Toggle";
import Checkbox from "@/components/ui/Checkbox";
import SaveBtn from "@/components/ui/SaveBtn";
import DangerBtn from "@/components/ui/DangerBtn";

const API_URL = "/api";

const SECTIONS = [
  { id: "account", label: "Account" },
  { id: "spotify", label: "Spotify" },
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
  { id: "paths", label: "Paths" },
  { id: "soulseek", label: "Soulseek" },
  { id: "matching", label: "Matching" },
  { id: "trackid", label: "Track ID" },
  { id: "fingerprint", label: "Fingerprint" },
  { id: "loudnorm", label: "Loudnorm" },
  { id: "coverart", label: "Cover Art" },
  { id: "billing", label: "Subscription" },
  { id: "export", label: "Export" },
  { id: "analysis", label: "Analysis" },
  { id: "danger", label: "Danger Zone" },
];

// ─── Field wrapper ───────────────────────────────────────────────────────────

function Field({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-[18px]">
      <label
        className="font-sans block mb-1"
        style={{ fontSize: 14, fontWeight: 600, color: "var(--hw-text)" }}
      >
        {label}
      </label>
      {desc && (
        <p
          className="font-sans mb-2"
          style={{
            fontSize: 12,
            color: "var(--hw-text-dim)",
            lineHeight: 1.5,
          }}
        >
          {desc}
        </p>
      )}
      {children}
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [mounted, setMounted] = useState(false);
  const [activeSection, setActiveSection] = useState("account");
  const [disconnecting, setDisconnecting] = useState(false);
  const [loading, setLoading] = useState(true);
  const searchParams = useSearchParams();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Theme
  const { theme, setTheme } = useTheme();

  // Grain overlay (localStorage only)
  const [grainEnabled, setGrainEnabled] = useState(true);

  // Account
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");

  // Paths
  const [downloadsDir, setDownloadsDir] = useState("");
  const [libraryDir, setLibraryDir] = useState("");

  // Soulseek
  const [slskUser, setSlskUser] = useState("");
  const [slskPassword, setSlskPassword] = useState("");
  const [slskEnabled, setSlskEnabled] = useState(true);

  // Matching
  const [minScore, setMinScore] = useState(0.86);

  // Track ID
  const [trackidConfidence, setTrackidConfidence] = useState(0.7);
  const [durTolerance, setDurTolerance] = useState(2000);
  const [searchTimeout, setSearchTimeout] = useState(15);

  // Fingerprint
  const [fpEnabled, setFpEnabled] = useState(true);
  const [acoustidKey, setAcoustidKey] = useState("");

  // Loudnorm
  const [targetLufs, setTargetLufs] = useState(-9);
  const [loudnormEnabled, setLoudnormEnabled] = useState(true);

  // Cover Art
  const [coverartSources, setCoverartSources] = useState<string[]>([
    "coverartarchive",
    "itunes",
    "deezer",
    "spotify",
    "lastfm",
  ]);
  const [coverartEnabled, setCoverartEnabled] = useState(true);

  // Export
  const [exportFormats, setExportFormats] = useState<string[]>([]);
  const [exportOutputPath, setExportOutputPath] = useState("");

  // Analysis
  const [analysisModelPath, setAnalysisModelPath] = useState("");
  const [analysisEnabled, setAnalysisEnabled] = useState(false);

  // Push notifications
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushToggling, setPushToggling] = useState(false);
  const [pushPermission, setPushPermission] = useState<NotificationPermission | "unsupported">("default");
  const [pushSupported, setPushSupported] = useState(true);

  // ─── Spotify connection (preserved from original) ────────────────────────

  useEffect(() => {
    if (searchParams.get("spotify") === "connected") {
      toast.success("Spotify connected successfully!");
      window.history.replaceState({}, "", "/settings");
    } else if (searchParams.get("spotify") === "error") {
      toast.error("Spotify connection failed. Please try again.");
      window.history.replaceState({}, "", "/settings");
    }
  }, [searchParams]);

  async function handleDisconnect() {
    if (
      !confirm(
        "Disconnect Spotify? You won't be able to import playlists until you reconnect.",
      )
    )
      return;
    setDisconnecting(true);
    try {
      await disconnectSpotify();
      toast.success("Spotify disconnected");
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Failed to disconnect",
      );
    } finally {
      setDisconnecting(false);
    }
  }

  // ─── Load settings ──────────────────────────────────────────────────────

  useEffect(() => {
    setMounted(true);

    // Grain from localStorage
    const stored = localStorage.getItem("djtoolkit-grain");
    if (stored !== null) setGrainEnabled(stored !== "false");

    // Push notification feature detection
    const supported =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window;
    setPushSupported(supported);
    if (supported && "Notification" in window) {
      setPushPermission(Notification.permission);
    } else {
      setPushPermission("unsupported");
    }

    async function load() {
      try {
        const { settings, email: userEmail } = await fetchSettings();
        if (userEmail) setEmail(userEmail);
        applySettings(settings);
      } catch {
        // Settings table may not exist yet — use defaults
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  function applySettings(s: UserSettings) {
    if (s.display_name != null) setDisplayName(s.display_name);
    if (s.downloads_dir != null) setDownloadsDir(s.downloads_dir);
    if (s.library_dir != null) setLibraryDir(s.library_dir);
    if (s.soulseek_username != null) setSlskUser(s.soulseek_username);
    if (s.soulseek_password != null) setSlskPassword(s.soulseek_password);
    if (s.soulseek_enabled != null) setSlskEnabled(s.soulseek_enabled);
    if (s.min_score != null) setMinScore(s.min_score);
    if (s.duration_tolerance_ms != null)
      setDurTolerance(s.duration_tolerance_ms);
    if (s.search_timeout_sec != null) setSearchTimeout(s.search_timeout_sec);
    if (s.fingerprint_enabled != null) setFpEnabled(s.fingerprint_enabled);
    if (s.acoustid_api_key != null) setAcoustidKey(s.acoustid_api_key);
    if (s.loudnorm_target_lufs != null)
      setTargetLufs(s.loudnorm_target_lufs);
    if (s.loudnorm_enabled != null) setLoudnormEnabled(s.loudnorm_enabled);
    if (s.coverart_sources != null) setCoverartSources(s.coverart_sources);
    if (s.coverart_enabled != null) setCoverartEnabled(s.coverart_enabled);
    if (s.export_formats != null) setExportFormats(s.export_formats);
    if (s.export_output_path != null)
      setExportOutputPath(s.export_output_path);
    if (s.analysis_essentia_model_path != null)
      setAnalysisModelPath(s.analysis_essentia_model_path);
    if (s.analysis_enabled != null) setAnalysisEnabled(s.analysis_enabled);
    if (s.push_notifications_enabled != null)
      setPushEnabled(s.push_notifications_enabled);
    if (s.trackid_confidence_threshold != null)
      setTrackidConfidence(s.trackid_confidence_threshold);
  }

  // ─── IntersectionObserver scroll spy ────────────────────────────────────

  useEffect(() => {
    if (!mounted) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActiveSection(e.target.id);
        });
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [mounted]);

  // ─── Save handlers ─────────────────────────────────────────────────────

  const saveAccount = useCallback(async () => {
    await updateSettings({ display_name: displayName });
    toast.success("Account settings saved");
  }, [displayName]);

  const savePaths = useCallback(async () => {
    await updateSettings({
      downloads_dir: downloadsDir,
      library_dir: libraryDir,
    });
    toast.success("Paths saved");
  }, [downloadsDir, libraryDir]);

  const saveSoulseek = useCallback(async () => {
    await updateSettings({
      soulseek_username: slskUser,
      soulseek_password: slskPassword,
      soulseek_enabled: slskEnabled,
    });
    toast.success("Soulseek settings saved");
  }, [slskUser, slskPassword, slskEnabled]);

  const saveMatching = useCallback(async () => {
    await updateSettings({
      min_score: minScore,
      duration_tolerance_ms: durTolerance,
      search_timeout_sec: searchTimeout,
    });
    toast.success("Matching settings saved");
  }, [minScore, durTolerance, searchTimeout]);

  const saveTrackId = useCallback(async () => {
    await updateSettings({
      trackid_confidence_threshold: trackidConfidence,
    });
    toast.success("Track ID settings saved");
  }, [trackidConfidence]);

  const saveFingerprint = useCallback(async () => {
    await updateSettings({
      fingerprint_enabled: fpEnabled,
      acoustid_api_key: acoustidKey,
    });
    toast.success("Fingerprint settings saved");
  }, [fpEnabled, acoustidKey]);

  const saveLoudnorm = useCallback(async () => {
    await updateSettings({
      loudnorm_target_lufs: targetLufs,
      loudnorm_enabled: loudnormEnabled,
    });
    toast.success("Loudnorm settings saved");
  }, [targetLufs, loudnormEnabled]);

  const saveCoverart = useCallback(async () => {
    await updateSettings({
      coverart_sources: coverartSources,
      coverart_enabled: coverartEnabled,
    });
    toast.success("Cover art settings saved");
  }, [coverartSources, coverartEnabled]);

  const saveExport = useCallback(async () => {
    await updateSettings({
      export_formats: exportFormats,
      export_output_path: exportOutputPath,
    });
    toast.success("Export settings saved");
  }, [exportFormats, exportOutputPath]);

  const saveAnalysis = useCallback(async () => {
    await updateSettings({
      analysis_essentia_model_path: analysisModelPath,
      analysis_enabled: analysisEnabled,
    });
    toast.success("Analysis settings saved");
  }, [analysisModelPath, analysisEnabled]);

  // ─── Push notifications toggle ────────────────────────────────────────

  async function handlePushToggle(on: boolean) {
    setPushToggling(true);
    try {
      if (on) {
        const { subscribeToPush } = await import("@/lib/push-notifications");
        const sub = await subscribeToPush();
        if (!sub) {
          // Permission denied or subscription failed
          setPushPermission(
            "Notification" in window ? Notification.permission : "unsupported",
          );
          toast.error(
            Notification.permission === "denied"
              ? "Notifications blocked by your browser"
              : "Failed to enable notifications",
          );
          setPushToggling(false);
          return;
        }
        setPushEnabled(true);
        setPushPermission("granted");
        await updateSettings({ push_notifications_enabled: true });
        toast.success("Push notifications enabled");
      } else {
        const { unsubscribeFromPush } = await import(
          "@/lib/push-notifications"
        );
        await unsubscribeFromPush();
        setPushEnabled(false);
        await updateSettings({ push_notifications_enabled: false });
        toast.success("Push notifications disabled");
      }
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update notifications",
      );
    } finally {
      setPushToggling(false);
    }
  }

  // ─── Appearance (localStorage only) ────────────────────────────────────

  function handleGrainToggle(on: boolean) {
    setGrainEnabled(on);
    localStorage.setItem("djtoolkit-grain", String(on));
    // Dispatch custom event so Grain component can react
    window.dispatchEvent(
      new CustomEvent("djtoolkit-grain-change", { detail: on }),
    );
  }

  // ─── Danger zone ───────────────────────────────────────────────────────

  async function handleClearLibrary() {
    if (
      !confirm(
        "Clear your entire library? All tracks will be removed. Downloads on disk are not deleted.",
      )
    )
      return;
    try {
      const { deleted } = await clearLibrary();
      toast.success(`Library cleared (${deleted} tracks removed)`);
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Failed to clear library",
      );
    }
  }

  async function handleDeleteAccount() {
    if (
      !confirm(
        "Permanently delete your account and all data? This cannot be undone.",
      )
    )
      return;
    if (!confirm("Are you absolutely sure? Type OK to confirm.")) return;
    try {
      await deleteAccount();
      toast.success("Account deleted");
      // Sign out and redirect
      const supabase = createClient();
      await supabase.auth.signOut();
      window.location.href = "/";
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete account",
      );
    }
  }

  // ─── Export format toggle helper ───────────────────────────────────────

  function toggleExportFormat(format: string, checked: boolean) {
    setExportFormats((prev) =>
      checked ? [...prev, format] : prev.filter((f) => f !== format),
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────

  if (!mounted || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p
          className="font-mono text-xs uppercase tracking-widest"
          style={{ color: "var(--hw-text-dim)" }}
        >
          Loading settings...
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Section nav — hidden below lg */}
      <div
        className="hidden lg:block shrink-0 overflow-auto border-r"
        style={{
          width: 170,
          minWidth: 170,
          borderColor: "var(--hw-border-light)",
          background: "var(--hw-surface)",
          padding: "20px 0",
        }}
      >
        <div
          className="font-mono uppercase"
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: "var(--hw-text-dim)",
            letterSpacing: 1.5,
            padding: "0 14px 12px",
          }}
        >
          Settings
        </div>
        <SectionNav
          sections={SECTIONS}
          activeId={activeSection}
          onSelect={setActiveSection}
        />
      </div>

      {/* Form area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto"
        style={{ padding: "clamp(20px, 3vw, 32px)", maxWidth: 720 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-7">
          <h1
            className="font-sans"
            style={{ fontSize: 28, fontWeight: 900, letterSpacing: -1 }}
          >
            Settings
          </h1>
        </div>

        {/* ─── ACCOUNT ──────────────────────────────────────────────── */}
        <Section
          id="account"
          title="Account"
          desc="Your profile and credentials"
        >
          <Field label="Email">
            <input
              readOnly
              value={email}
              aria-label="Email"
              className="w-full font-mono"
              style={{
                fontSize: 13,
                color: "var(--hw-text-dim)",
                background: "var(--hw-input-bg)",
                border: "1.5px solid var(--hw-input-border)",
                borderRadius: 5,
                padding: "10px 14px",
                outline: "none",
                cursor: "default",
                opacity: 0.7,
              }}
            />
          </Field>
          <Field label="Display name">
            <TextInput
              value={displayName}
              onChange={setDisplayName}
              placeholder="Your DJ name"
              aria-label="Display name"
            />
          </Field>
          <div className="flex justify-end mt-4">
            <SaveBtn onClick={saveAccount} />
          </div>
        </Section>

        {/* ─── SPOTIFY ──────────────────────────────────────────────── */}
        <Section
          id="spotify"
          title="Spotify"
          desc="Connect your Spotify account for playlist import"
        >
          <div className="flex items-center justify-between">
            <div>
              <div
                className="font-sans"
                style={{ fontSize: 14, fontWeight: 600, color: "var(--hw-text)" }}
              >
                Connection status
              </div>
              <div
                className="font-mono mt-1"
                style={{ fontSize: 11, color: "var(--hw-text-dim)" }}
              >
                Connect to enable Spotify playlist import
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  const supabase = createClient();
                  const {
                    data: { session },
                  } = await supabase.auth.getSession();
                  const token = session?.access_token ?? "";
                  window.location.href = `${API_URL}/auth/spotify/connect?token=${encodeURIComponent(token)}&return_to=/settings`;
                }}
                className="font-mono cursor-pointer transition-all duration-150"
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "8px 16px",
                  borderRadius: 5,
                  background: "transparent",
                  color: "var(--led-blue)",
                  border: "1.5px solid var(--hw-border-light)",
                }}
              >
                Connect
              </button>
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="font-mono cursor-pointer transition-all duration-150"
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "8px 16px",
                  borderRadius: 5,
                  background: "transparent",
                  color: "var(--hw-error-text)",
                  border: "1.5px solid var(--hw-border-light)",
                  opacity: disconnecting ? 0.5 : 1,
                }}
              >
                {disconnecting ? "Disconnecting..." : "Disconnect"}
              </button>
            </div>
          </div>
        </Section>

        {/* ─── APPEARANCE ───────────────────────────────────────────── */}
        <Section id="appearance" title="Appearance">
          <Field label="Theme">
            <div className="flex gap-2">
              {(["dark", "light", "system"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className="font-mono cursor-pointer transition-all duration-150 capitalize"
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: "8px 18px",
                    borderRadius: 5,
                    background:
                      theme === t
                        ? "color-mix(in srgb, var(--led-blue) 8%, transparent)"
                        : "transparent",
                    color:
                      theme === t ? "var(--led-blue)" : "var(--hw-text-dim)",
                    border: `1.5px solid ${
                      theme === t
                        ? "color-mix(in srgb, var(--led-blue) 27%, transparent)"
                        : "var(--hw-border-light)"
                    }`,
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Grain overlay" desc="Subtle film grain texture over the UI">
            <Toggle checked={grainEnabled} onChange={handleGrainToggle} aria-label="Grain overlay" />
          </Field>
        </Section>

        {/* ─── NOTIFICATIONS ──────────────────────────────────────── */}
        <Section
          id="notifications"
          title="Notifications"
          desc="Get notified when pipeline batches finish or tracks fail"
        >
          <Field label="Enable push notifications">
            {!pushSupported ? (
              <div className="flex items-center gap-2">
                <Toggle checked={false} onChange={() => {}} disabled aria-label="Push notifications" />
                <span
                  className="font-sans text-xs"
                  style={{ color: "var(--hw-text-dim)" }}
                >
                  Your browser does not support push notifications
                </span>
              </div>
            ) : pushPermission === "denied" ? (
              <div className="flex flex-col gap-2">
                <Toggle checked={false} onChange={() => {}} disabled aria-label="Push notifications" />
                <p
                  className="font-sans"
                  style={{
                    fontSize: 12,
                    color: "var(--hw-error-text)",
                    lineHeight: 1.5,
                  }}
                >
                  Notifications blocked by your browser. Allow notifications in
                  browser settings to enable.
                </p>
              </div>
            ) : (
              <Toggle
                checked={pushEnabled}
                onChange={handlePushToggle}
                disabled={pushToggling}
                aria-label="Push notifications"
              />
            )}
          </Field>
        </Section>

        {/* ─── PATHS ────────────────────────────────────────────────── */}
        <Section
          id="paths"
          title="Paths"
          desc="File system paths for downloads and library"
        >
          <Field label="Downloads directory">
            <TextInput
              value={downloadsDir}
              onChange={setDownloadsDir}
              mono
              placeholder="~/Soulseek/downloads/complete"
              aria-label="Downloads directory"
            />
          </Field>
          <Field label="Library directory">
            <TextInput
              value={libraryDir}
              onChange={setLibraryDir}
              mono
              placeholder="~/Music/DJ/library"
              aria-label="Library directory"
            />
          </Field>
          <div className="flex justify-end mt-4">
            <SaveBtn onClick={savePaths} />
          </div>
        </Section>

        {/* ─── SOULSEEK ─────────────────────────────────────────────── */}
        <Section
          id="soulseek"
          title="Soulseek"
          desc="Soulseek network credentials and toggle"
        >
          <Field label="Enabled">
            <Toggle checked={slskEnabled} onChange={setSlskEnabled} aria-label="Soulseek enabled" />
          </Field>
          <Field label="Username">
            <TextInput value={slskUser} onChange={setSlskUser} mono aria-label="Soulseek username" />
          </Field>
          <Field label="Password">
            <TextInput
              value={slskPassword}
              onChange={setSlskPassword}
              mono
              type="password"
              aria-label="Soulseek password"
            />
          </Field>
          <div className="flex justify-end mt-4">
            <SaveBtn onClick={saveSoulseek} />
          </div>
        </Section>

        {/* ─── MATCHING ─────────────────────────────────────────────── */}
        <Section
          id="matching"
          title="Matching"
          desc="Fuzzy matching thresholds for track identification"
        >
          <Field label="Minimum score">
            <NumberInput
              value={minScore}
              onChange={setMinScore}
              step={0.01}
              min={0}
              max={1}
              aria-label="Minimum score"
            />
          </Field>
          <Field label="Duration tolerance (ms)" desc="Plus/minus tolerance in milliseconds">
            <NumberInput
              value={durTolerance}
              onChange={setDurTolerance}
              step={100}
              aria-label="Duration tolerance"
            />
          </Field>
          <Field label="Search timeout (sec)">
            <NumberInput
              value={searchTimeout}
              onChange={setSearchTimeout}
              step={1}
              aria-label="Search timeout"
            />
          </Field>
          <div className="flex justify-end mt-4">
            <SaveBtn onClick={saveMatching} />
          </div>
        </Section>

        {/* ─── TRACK ID ────────────────────────────────────────────── */}
        <Section
          id="trackid"
          title="Track ID"
          desc="Minimum confidence for accepting identified tracks from TrackID.dev"
        >
          <Field
            label="Confidence threshold"
            desc="0.0–1.0 — higher means fewer but more accurate results"
          >
            <NumberInput
              value={trackidConfidence}
              onChange={setTrackidConfidence}
              step={0.05}
              min={0.1}
              max={1}
              aria-label="Confidence threshold"
            />
          </Field>
          <div className="flex justify-end mt-4">
            <SaveBtn onClick={saveTrackId} />
          </div>
        </Section>

        {/* ─── FINGERPRINT ──────────────────────────────────────────── */}
        <Section
          id="fingerprint"
          title="Fingerprint"
          desc="AcoustID fingerprinting for duplicate detection"
        >
          <Field label="Enabled">
            <Toggle checked={fpEnabled} onChange={setFpEnabled} aria-label="Fingerprint enabled" />
          </Field>
          <Field label="AcoustID API key">
            <TextInput
              value={acoustidKey}
              onChange={setAcoustidKey}
              mono
              placeholder="Your AcoustID API key"
              aria-label="AcoustID API key"
            />
          </Field>
          <div className="flex justify-end mt-4">
            <SaveBtn onClick={saveFingerprint} />
          </div>
        </Section>

        {/* ─── LOUDNORM ─────────────────────────────────────────────── */}
        <Section
          id="loudnorm"
          title="Loudness Normalization"
          desc="Target loudness levels for processed audio"
        >
          <Field label="Enabled">
            <Toggle checked={loudnormEnabled} onChange={setLoudnormEnabled} aria-label="Loudness normalization enabled" />
          </Field>
          <Field label="Target LUFS">
            <NumberInput
              value={targetLufs}
              onChange={setTargetLufs}
              step={0.5}
              aria-label="Target LUFS"
            />
          </Field>
          <div className="flex justify-end mt-4">
            <SaveBtn onClick={saveLoudnorm} />
          </div>
        </Section>

        {/* ─── COVER ART ────────────────────────────────────────────── */}
        <Section id="coverart" title="Cover Art">
          <Field label="Enabled">
            <Toggle checked={coverartEnabled} onChange={setCoverartEnabled} aria-label="Cover art enabled" />
          </Field>
          <Field
            label="Sources priority"
            desc="Check the sources to search, in order of priority"
          >
            <div className="flex flex-col gap-2">
              {[
                "coverartarchive",
                "itunes",
                "deezer",
                "spotify",
                "lastfm",
              ].map((src) => (
                <Checkbox
                  key={src}
                  label={src}
                  checked={coverartSources.includes(src)}
                  onChange={(checked) =>
                    setCoverartSources((prev) =>
                      checked
                        ? [...prev, src]
                        : prev.filter((s) => s !== src),
                    )
                  }
                />
              ))}
            </div>
          </Field>
          <div className="flex justify-end mt-4">
            <SaveBtn onClick={saveCoverart} />
          </div>
        </Section>

        {/* ─── BILLING ──────────────────────────────────────────────── */}
        <Section id="billing" title="Subscription">
          <div className="flex items-center justify-between">
            <div>
              <div
                className="font-sans"
                style={{ fontSize: 16, fontWeight: 700, color: "var(--hw-text)" }}
              >
                Coming soon
              </div>
              <div
                className="font-sans mt-1"
                style={{ fontSize: 13, color: "var(--hw-text-dim)" }}
              >
                Subscription management will be available in a future update.
              </div>
            </div>
          </div>
        </Section>

        {/* ─── EXPORT ───────────────────────────────────────────────── */}
        <Section
          id="export"
          title="Export"
          desc="Formats and output path for DJ software export"
        >
          <Field label="Formats">
            <div className="flex flex-col gap-2">
              {["rekordbox", "serato", "traktor"].map((fmt) => (
                <Checkbox
                  key={fmt}
                  label={fmt}
                  checked={exportFormats.includes(fmt)}
                  onChange={(checked) => toggleExportFormat(fmt, checked)}
                />
              ))}
            </div>
          </Field>
          <Field label="Output path">
            <TextInput
              value={exportOutputPath}
              onChange={setExportOutputPath}
              mono
              placeholder="~/Music/exports"
              aria-label="Export output path"
            />
          </Field>
          <div className="flex justify-end mt-4">
            <SaveBtn onClick={saveExport} />
          </div>
        </Section>

        {/* ─── ANALYSIS ─────────────────────────────────────────────── */}
        <Section
          id="analysis"
          title="Audio Analysis"
          desc="ML model settings for genre detection"
        >
          <Field label="Enabled">
            <Toggle checked={analysisEnabled} onChange={setAnalysisEnabled} aria-label="Audio analysis enabled" />
          </Field>
          <Field
            label="Essentia model path"
            desc="Optional — requires essentia-tensorflow"
          >
            <TextInput
              value={analysisModelPath}
              onChange={setAnalysisModelPath}
              mono
              placeholder="~/.djtoolkit/models"
              aria-label="Essentia model path"
            />
          </Field>
          <div className="flex justify-end mt-4">
            <SaveBtn onClick={saveAnalysis} />
          </div>
        </Section>

        {/* ─── DANGER ZONE ──────────────────────────────────────────── */}
        <Section id="danger" title="Danger Zone">
          <div className="flex flex-col gap-3.5">
            <div className="flex items-center justify-between">
              <div>
                <div
                  className="font-sans"
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--hw-text)",
                  }}
                >
                  Clear library
                </div>
                <div
                  className="font-sans"
                  style={{ fontSize: 12, color: "var(--hw-text-dim)" }}
                >
                  Remove all tracks from your catalog. Downloads are not
                  deleted.
                </div>
              </div>
              <DangerBtn onClick={handleClearLibrary}>Clear library</DangerBtn>
            </div>
            <div
              style={{ height: 1, background: "var(--hw-border)" }}
            />
            <div className="flex items-center justify-between">
              <div>
                <div
                  className="font-sans"
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--hw-text)",
                  }}
                >
                  Delete account
                </div>
                <div
                  className="font-sans"
                  style={{ fontSize: 12, color: "var(--hw-text-dim)" }}
                >
                  Permanently delete your account and all data. This cannot be
                  undone.
                </div>
              </div>
              <DangerBtn onClick={handleDeleteAccount}>
                Delete account
              </DangerBtn>
            </div>
          </div>
        </Section>

        {/* Bottom spacer */}
        <div className="h-16" />
      </div>
    </div>
  );
}
