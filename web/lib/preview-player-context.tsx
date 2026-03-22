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

  // Load the Spotify iFrame API script once
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

  // Create or update the embed controller when URI changes
  useEffect(() => {
    if (!apiReady || !currentUri || !embedRef.current) return;

    const IFrameAPI = (window as any).SpotifyIframeApi;
    if (!IFrameAPI) return;

    // If controller already exists, just load the new URI
    if (controllerRef.current) {
      controllerRef.current.loadUri(currentUri);
      controllerRef.current.play();
      return;
    }

    // Clear the container before creating a new controller
    embedRef.current.innerHTML = "";

    const options = {
      uri: currentUri,
      width: 300,
      height: 80,
    };

    IFrameAPI.createController(
      embedRef.current,
      options,
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

  const play = useCallback((trackId: number, spotifyUri: string) => {
    setCurrentTrackId(trackId);
    setCurrentUri(spotifyUri);
    setIsPlaying(true);
  }, []);

  const pause = useCallback(() => {
    controllerRef.current?.togglePlay();
  }, []);

  const stop = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.destroy();
      controllerRef.current = null;
    }
    setCurrentTrackId(null);
    setCurrentUri(null);
    setIsPlaying(false);
  }, []);

  const LED = LED_COLORS.green;

  return (
    <PreviewPlayerContext.Provider
      value={{ currentTrackId, isPlaying, play, pause, stop }}
    >
      {children}

      {/* Floating Spotify embed player */}
      {currentUri && (
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
          <div ref={embedRef} />
        </div>
      )}
    </PreviewPlayerContext.Provider>
  );
}
