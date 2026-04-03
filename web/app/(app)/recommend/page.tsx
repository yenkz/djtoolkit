"use client";

import { useState, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import EntryScreen from "@/components/recommend/EntryScreen";
import VenueBrowser from "@/components/recommend/VenueBrowser";
import VenueDetail from "@/components/recommend/VenueDetail";
import MoodSelector from "@/components/recommend/MoodSelector";
import SeedList from "@/components/recommend/SeedList";
import SimilarityGraph from "@/components/recommend/SimilarityGraph";
import ResultsList from "@/components/recommend/ResultsList";
import ExportDialog from "@/components/recommend/ExportDialog";
import {
  generateSeeds,
  expandSeeds,
  refineResults,
  restoreSession,
  type Venue,
  type SeedResponse,
  type ExpandResponse,
  type SeedFeedback,
} from "@/lib/api";
import { HARDWARE } from "@/lib/design-system/tokens";

type Step = "entry" | "venue-browse" | "venue-detail" | "mood" | "seeds" | "results";

export default function RecommendPage() {
  const searchParams = useSearchParams();
  const [step, setStep] = useState<Step>("entry");
  const [selectedVenue, setSelectedVenue] = useState<Venue | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [seedResponse, setSeedResponse] = useState<SeedResponse | null>(null);
  const [expandResponse, setExpandResponse] = useState<ExpandResponse | null>(null);
  const [seedFeedback, setSeedFeedback] = useState<SeedFeedback[]>([]);
  const [lineupPosition, setLineupPosition] = useState("middle");
  const [loading, setLoading] = useState(false);
  const [refining, setRefining] = useState(false);
  const [showExport, setShowExport] = useState(false);

  // Restore session from ?session= query param
  useEffect(() => {
    const sid = searchParams.get("session");
    if (!sid) return;

    setLoading(true);
    restoreSession(sid)
      .then((res) => {
        setSessionId(res.session_id);
        setLineupPosition(res.lineup_position);
        setExpandResponse({
          tracks: res.tracks,
          energy_arc: res.energy_arc,
          similarity_edges: res.similarity_edges,
        });
        // Mark all tracks as liked seeds for the graph
        setSeedFeedback(
          res.tracks.slice(0, 10).map((t, i) => ({
            track_id: t.id,
            liked: true,
            position: i + 1,
          }))
        );
        setStep("results");
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Failed to restore session");
      })
      .finally(() => setLoading(false));
  }, [searchParams]);

  const handleSelectVenue = useCallback((venue: Venue) => {
    setSelectedVenue(venue);
    setStep("venue-detail");
  }, []);

  const handleGenerateSeedsFromVenue = useCallback(async (lineup: string) => {
    if (!selectedVenue) return;
    setLoading(true);
    setLineupPosition(lineup);
    try {
      const res = await generateSeeds({ venue_id: selectedVenue.id, lineup_position: lineup });
      setSessionId(res.session_id);
      setSeedResponse(res);
      setStep("seeds");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate seeds");
    } finally {
      setLoading(false);
    }
  }, [selectedVenue]);

  const handleGenerateSeedsFromMood = useCallback(async (moodPresetId: string, lineup: string) => {
    setLoading(true);
    setLineupPosition(lineup);
    try {
      const res = await generateSeeds({ mood_preset_id: moodPresetId, lineup_position: lineup });
      setSessionId(res.session_id);
      setSeedResponse(res);
      setStep("seeds");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate seeds");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleExpand = useCallback(async (feedback: SeedFeedback[]) => {
    if (!sessionId) return;
    setLoading(true);
    setSeedFeedback(feedback);
    try {
      const res = await expandSeeds(sessionId, feedback);
      setExpandResponse(res);
      setStep("results");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to expand");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const handleRefine = useCallback(async (feedback: { track_id: number; liked: boolean }[]) => {
    if (!sessionId) return;
    setRefining(true);
    try {
      const res = await refineResults(sessionId, feedback);
      setExpandResponse(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to refine");
    } finally {
      setRefining(false);
    }
  }, [sessionId]);

  const handleRegenerate = useCallback(() => {
    if (selectedVenue) {
      setStep("venue-detail");
    } else {
      setStep("mood");
    }
  }, [selectedVenue]);

  const handleBack = useCallback(() => {
    if (step === "venue-browse" || step === "mood") setStep("entry");
    else if (step === "venue-detail") setStep("venue-browse");
    else if (step === "seeds") setStep(selectedVenue ? "venue-detail" : "mood");
    else if (step === "results") setStep("seeds");
  }, [step, selectedVenue]);

  const seedIds = new Set(seedFeedback.filter(f => f.liked).map(f => f.track_id));

  return (
    <div className="flex-1 overflow-auto p-6">
      {step !== "entry" && (
        <button
          onClick={handleBack}
          style={{ color: HARDWARE.textDim, fontSize: 13, marginBottom: 16, cursor: "pointer", background: "none", border: "none" }}
        >
          &larr; Back
        </button>
      )}

      {step === "entry" && !loading && (
        <EntryScreen
          onSelectVenue={() => setStep("venue-browse")}
          onSelectMood={() => setStep("mood")}
        />
      )}

      {step === "entry" && loading && (
        <p style={{ color: HARDWARE.textDim, fontSize: 13, textAlign: "center", marginTop: 40 }}>
          Restoring session...
        </p>
      )}

      {step === "venue-browse" && (
        <VenueBrowser onSelectVenue={handleSelectVenue} />
      )}

      {step === "venue-detail" && selectedVenue && (
        <VenueDetail
          venue={selectedVenue}
          onGenerateSeeds={handleGenerateSeedsFromVenue}
          loading={loading}
        />
      )}

      {step === "mood" && (
        <MoodSelector
          onGenerateSeeds={handleGenerateSeedsFromMood}
          loading={loading}
        />
      )}

      {step === "seeds" && seedResponse && (
        <SeedList
          seeds={seedResponse.seeds}
          unanalyzedCount={seedResponse.unanalyzed_count}
          onExpand={handleExpand}
          onRegenerate={handleRegenerate}
          loading={loading}
        />
      )}

      {step === "results" && expandResponse && (
        <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 80px)" }}>
          <div style={{ flexShrink: 0 }}>
            <SimilarityGraph
              tracks={expandResponse.tracks}
              edges={expandResponse.similarity_edges}
              seedIds={seedIds}
              onLike={() => {}}
              onDislike={() => {}}
            />
          </div>
          <div style={{ flex: 1, overflow: "auto", marginTop: 16, minHeight: 0 }}>
            <ResultsList
              tracks={expandResponse.tracks}
              onRefine={handleRefine}
              onExport={() => setShowExport(true)}
              refining={refining}
            />
          </div>
        </div>
      )}

      {showExport && sessionId && (
        <ExportDialog
          sessionId={sessionId}
          defaultName={`Recommendation \u2014 ${lineupPosition}`}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}
