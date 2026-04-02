"use client";

import { useState, useCallback } from "react";
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
  type Venue,
  type SeedResponse,
  type ExpandResponse,
  type SeedFeedback,
} from "@/lib/api";
import { HARDWARE } from "@/lib/design-system/tokens";

type Step = "entry" | "venue-browse" | "venue-detail" | "mood" | "seeds" | "results";

export default function RecommendPage() {
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

      {step === "entry" && (
        <EntryScreen
          onSelectVenue={() => setStep("venue-browse")}
          onSelectMood={() => setStep("mood")}
        />
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
        <>
          <SimilarityGraph
            tracks={expandResponse.tracks}
            edges={expandResponse.similarity_edges}
            seedIds={seedIds}
            onLike={() => {}}
            onDislike={() => {}}
          />
          <div style={{ marginTop: 16 }}>
            <ResultsList
              tracks={expandResponse.tracks}
              onRefine={handleRefine}
              onExport={() => setShowExport(true)}
              refining={refining}
            />
          </div>
        </>
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
