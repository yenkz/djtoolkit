"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { LED_COLORS, HARDWARE, FONTS } from "@/lib/design-system/tokens";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface PreviewPlayerState {
  currentTrackId: number | null;
  isPlaying: boolean;
}

interface PreviewPlayerActions {
  play(trackId: number, spotifyUri: string): void;
  playUrl(trackId: number, audioUrl: string, meta?: { title?: string; artist?: string }): void;
  pause(): void;
  stop(): void;
}

type PreviewPlayerContextValue = PreviewPlayerState & PreviewPlayerActions;

const PreviewPlayerContext = createContext<PreviewPlayerContextValue | null>(
  null
);

export function usePreviewPlayer() {
  const ctx = useContext(PreviewPlayerContext);
  if (!ctx) {
    throw new Error("usePreviewPlayer must be used within PreviewPlayerProvider");
  }
  return ctx;
}

export function PreviewPlayerProvider({ children }: { children: ReactNode }) {
  const [currentTrackId, setCurrentTrackId] = useState<number | null>(null);
  const [currentUri, setCurrentUri] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [apiReady, setApiReady] = useState(
    () => typeof window !== "undefined" && !!(window as any).SpotifyIframeApi
  );
  const embedRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<any>(null);

  // ─── HTML5 Audio state ────────────────────────────────────────────────
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioMeta, setAudioMeta] = useState<{ title?: string; artist?: string } | null>(null);
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number>(0);

  // Track which player mode is active: "spotify" | "audio" | null
  const modeRef = useRef<"spotify" | "audio" | null>(null);

  // ─── Cleanup helpers ──────────────────────────────────────────────────

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setAudioUrl(null);
    setAudioMeta(null);
    setAudioProgress(0);
    setAudioDuration(0);
  }, []);

  const stopSpotify = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.destroy();
      controllerRef.current = null;
    }
    setCurrentUri(null);
  }, []);

  // ─── Load Spotify iFrame API once ─────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;
    if ((window as any).SpotifyIframeApi) return;

    (window as any).onSpotifyIframeApiReady = (IFrameAPI: any) => {
      (window as any).SpotifyIframeApi = IFrameAPI;
      setApiReady(true);
    };

    const existing = document.querySelector(
      'script[src="https://open.spotify.com/embed/iframe-api/v1"]'
    );
    if (!existing) {
      const script = document.createElement("script");
      script.src = "https://open.spotify.com/embed/iframe-api/v1";
      script.async = true;
      document.body.appendChild(script);
    }
  }, []);

  // ─── Spotify embed controller ─────────────────────────────────────────

  useEffect(() => {
    if (!apiReady || !currentUri || !embedRef.current) return;
    if (modeRef.current !== "spotify") return;

    const IFrameAPI = (window as any).SpotifyIframeApi;
    if (!IFrameAPI) return;

    if (controllerRef.current) {
      controllerRef.current.loadUri(currentUri);
      controllerRef.current.play();
      return;
    }

    embedRef.current.innerHTML = "";

    IFrameAPI.createController(
      embedRef.current,
      { uri: currentUri, width: 300, height: 80 },
      (controller: any) => {
        controllerRef.current = controller;

        controller.addListener("playback_update", (e: any) => {
          if (e.data.isPaused && !e.data.isBuffering) {
            setIsPlaying(false);
          } else if (!e.data.isPaused) {
            setIsPlaying(true);
          }
        });

        controller.addListener("ready", () => {
          controller.play();
        });
      }
    );
  }, [apiReady, currentUri]);

  // ─── Actions ──────────────────────────────────────────────────────────

  const play = useCallback((trackId: number, spotifyUri: string) => {
    stopAudio();
    modeRef.current = "spotify";
    setCurrentTrackId(trackId);
    setCurrentUri(spotifyUri);
    setIsPlaying(true);
  }, [stopAudio]);

  const playUrl = useCallback((trackId: number, url: string, meta?: { title?: string; artist?: string }) => {
    stopSpotify();
    stopAudio();
    modeRef.current = "audio";
    setCurrentTrackId(trackId);
    setAudioUrl(url);
    setAudioMeta(meta ?? null);
    setIsPlaying(true);

    const audio = new Audio(url);
    audioRef.current = audio;

    audio.addEventListener("ended", () => {
      setIsPlaying(false);
      setAudioProgress(0);
    });
    audio.addEventListener("pause", () => setIsPlaying(false));
    audio.addEventListener("play", () => setIsPlaying(true));
    audio.addEventListener("loadedmetadata", () => {
      setAudioDuration(audio.duration);
    });

    // Progress animation loop
    const tick = () => {
      if (audioRef.current) {
        setAudioProgress(audioRef.current.currentTime);
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    audio.play().catch(() => setIsPlaying(false));
  }, [stopSpotify, stopAudio]);

  const pause = useCallback(() => {
    if (modeRef.current === "spotify") {
      controllerRef.current?.togglePlay();
    } else if (modeRef.current === "audio") {
      if (audioRef.current) {
        if (audioRef.current.paused) {
          audioRef.current.play().catch(() => {});
          setIsPlaying(true);
        } else {
          audioRef.current.pause();
        }
      }
    }
  }, []);

  const stop = useCallback(() => {
    stopSpotify();
    stopAudio();
    modeRef.current = null;
    setCurrentTrackId(null);
    setIsPlaying(false);
  }, [stopSpotify, stopAudio]);

  const LED = LED_COLORS.green;

  const showSpotifyEmbed = modeRef.current === "spotify" && currentUri;
  const showAudioPlayer = modeRef.current === "audio" && audioUrl;
  const showPlayer = showSpotifyEmbed || showAudioPlayer;

  return (
    <PreviewPlayerContext.Provider
      value={{ currentTrackId, isPlaying, play, playUrl, pause, stop }}
    >
      {children}

      {/* Floating player */}
      {showPlayer && (
        <div
          style={{
            position: "fixed",
            bottom: 16,
            right: 16,
            zIndex: 100,
            borderRadius: 12,
            overflow: "hidden",
            border: `2px solid ${LED.on}`,
            boxShadow: `${LED.glowHot}, 0 8px 32px rgba(0,0,0,0.5)`,
            background: HARDWARE.surface,
            animation: "embedSlideUp 0.25s ease",
          }}
        >
          <style>{`
            @keyframes embedSlideUp {
              from { transform: translateY(20px); opacity: 0; }
              to   { transform: translateY(0); opacity: 1; }
            }
          `}</style>

          {/* Close button */}
          <button
            onClick={stop}
            aria-label="Close player"
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              zIndex: 101,
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: HARDWARE.groove,
              border: `1px solid ${HARDWARE.border}`,
              color: HARDWARE.textDim,
              fontFamily: FONTS.sans,
              fontSize: 12,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            &#10005;
          </button>

          {/* Spotify iFrame API container */}
          {showSpotifyEmbed && <div ref={embedRef} />}

          {/* HTML5 Audio mini player */}
          {showAudioPlayer && (
            <div
              style={{
                width: 300,
                padding: "12px 16px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {/* Track info */}
              <div style={{ paddingRight: 24 }}>
                <div
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 13,
                    fontWeight: 600,
                    color: HARDWARE.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {audioMeta?.title || "Preview"}
                </div>
                {audioMeta?.artist && (
                  <div
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 11,
                      color: HARDWARE.textDim,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {audioMeta.artist}
                  </div>
                )}
              </div>

              {/* Controls + progress */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {/* Play/pause */}
                <button
                  onClick={pause}
                  aria-label={isPlaying ? "Pause" : "Play"}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: HARDWARE.groove,
                    border: `1.5px solid ${LED.on}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  {isPlaying ? (
                    <svg width="8" height="10" viewBox="0 0 12 14">
                      <rect x="1" y="0" width="3.5" height="14" rx="1" fill={LED.on} />
                      <rect x="7.5" y="0" width="3.5" height="14" rx="1" fill={LED.on} />
                    </svg>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 24 24">
                      <path d="M6 3l12 9-12 9V3z" fill={LED.on} />
                    </svg>
                  )}
                </button>

                {/* Progress bar */}
                <div
                  style={{
                    flex: 1,
                    height: 4,
                    background: HARDWARE.groove,
                    borderRadius: 2,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: audioDuration > 0 ? `${(audioProgress / audioDuration) * 100}%` : "0%",
                      height: "100%",
                      background: LED.on,
                      borderRadius: 2,
                      transition: "width 0.1s linear",
                    }}
                  />
                </div>

                {/* Time */}
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 10,
                    color: HARDWARE.textDim,
                    minWidth: 32,
                    textAlign: "right",
                  }}
                >
                  {audioDuration > 0
                    ? `${Math.floor(audioProgress)}/${Math.floor(audioDuration)}s`
                    : ""}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </PreviewPlayerContext.Provider>
  );
}
