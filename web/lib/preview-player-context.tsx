"use client";

import {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { toast } from "sonner";

interface PreviewPlayerState {
  currentTrackId: number | null;
  isPlaying: boolean;
  progress: number;
}

interface PreviewPlayerActions {
  play(trackId: number, previewUrl: string): void;
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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTrackId, setCurrentTrackId] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  // Track whether we've already attempted a refresh for the current URL
  const refreshAttemptedRef = useRef(false);
  const currentTrackIdRef = useRef<number | null>(null);

  // Keep ref in sync for use in event handlers
  useEffect(() => {
    currentTrackIdRef.current = currentTrackId;
  }, [currentTrackId]);

  // Create audio element once
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "none";
    audioRef.current = audio;

    const onTimeUpdate = () => {
      if (audio.duration) {
        setProgress(audio.currentTime / audio.duration);
      }
    };

    const onEnded = () => {
      setCurrentTrackId(null);
      setIsPlaying(false);
      setProgress(0);
    };

    const onError = async () => {
      const trackId = currentTrackIdRef.current;
      if (!trackId || refreshAttemptedRef.current) {
        toast.error("Preview unavailable");
        setCurrentTrackId(null);
        setIsPlaying(false);
        setProgress(0);
        return;
      }

      // Attempt one refresh
      refreshAttemptedRef.current = true;
      try {
        const resp = await fetch(`/api/catalog/tracks/${trackId}/preview-url`, {
          method: "POST",
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.preview_url) {
            audio.src = data.preview_url;
            audio.play().catch(() => {
              toast.error("Preview unavailable");
              setCurrentTrackId(null);
              setIsPlaying(false);
              setProgress(0);
            });
            return;
          }
        }
      } catch {
        // refresh failed
      }

      toast.error("Preview unavailable");
      setCurrentTrackId(null);
      setIsPlaying(false);
      setProgress(0);
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.pause();
      audio.src = "";
    };
  }, []);

  const play = useCallback((trackId: number, previewUrl: string) => {
    const audio = audioRef.current;
    if (!audio) return;

    refreshAttemptedRef.current = false;
    setCurrentTrackId(trackId);
    setIsPlaying(true);
    setProgress(0);
    audio.src = previewUrl;
    audio.play().catch(() => {
      toast.error("Preview unavailable");
      setCurrentTrackId(null);
      setIsPlaying(false);
      setProgress(0);
    });
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    setCurrentTrackId(null);
    setIsPlaying(false);
    setProgress(0);
  }, []);

  return (
    <PreviewPlayerContext.Provider
      value={{ currentTrackId, isPlaying, progress, play, pause, stop }}
    >
      {children}
    </PreviewPlayerContext.Provider>
  );
}
