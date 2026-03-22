"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { LED_COLORS, HARDWARE, FONTS } from "@/lib/design-system/tokens";

interface PreviewPlayerState {
  currentTrackId: number | null;
  spotifyEmbedUrl: string | null;
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

/** Convert spotify:track:XXXXX to an embed URL */
function toEmbedUrl(spotifyUri: string): string | null {
  const parts = spotifyUri.split(":");
  if (parts.length === 3 && parts[1] === "track") {
    return `https://open.spotify.com/embed/track/${parts[2]}?utm_source=generator&theme=0&autoplay=1`;
  }
  return null;
}

export function PreviewPlayerProvider({ children }: { children: ReactNode }) {
  const [currentTrackId, setCurrentTrackId] = useState<number | null>(null);
  const [spotifyEmbedUrl, setSpotifyEmbedUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const play = useCallback((trackId: number, spotifyUri: string) => {
    const url = toEmbedUrl(spotifyUri);
    if (!url) return;
    setCurrentTrackId(trackId);
    setSpotifyEmbedUrl(url);
    setIsPlaying(true);
  }, []);

  const pause = useCallback(() => {
    setIsPlaying(false);
    setSpotifyEmbedUrl(null);
    setCurrentTrackId(null);
  }, []);

  const stop = useCallback(() => {
    setCurrentTrackId(null);
    setSpotifyEmbedUrl(null);
    setIsPlaying(false);
  }, []);

  const LED = LED_COLORS.green;

  return (
    <PreviewPlayerContext.Provider
      value={{ currentTrackId, spotifyEmbedUrl, isPlaying, play, pause, stop }}
    >
      {children}

      {/* Floating Spotify embed player */}
      {spotifyEmbedUrl && (
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

          <iframe
            src={spotifyEmbedUrl}
            width={300}
            height={80}
            frameBorder={0}
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            loading="lazy"
            style={{ display: "block" }}
          />
        </div>
      )}
    </PreviewPlayerContext.Provider>
  );
}
