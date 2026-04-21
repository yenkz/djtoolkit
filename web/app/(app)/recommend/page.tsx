"use client";

import React from "react";
import { useState, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Check } from "lucide-react";
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
import { stepToIndex, STEP_LABELS, type Step } from "./step-index";

function Stepper({ currentStep }: { currentStep: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "14px 24px",
        borderBottom: "1px solid var(--hw-border)",
        flexShrink: 0,
        marginBottom: 16,
      }}
    >
      {STEP_LABELS.map((label, i) => {
        const done = i < currentStep;
        const current = i === currentStep;
        return (
          <React.Fragment key={label}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  background: done ? "var(--led-blue)" : current ? "var(--hw-panel)" : "var(--hw-raised)",
                  border: `2px solid ${i <= currentStep ? "var(--led-blue)" : "var(--hw-border-light)"}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: current ? "0 0 0 3px rgba(68,136,255,0.15)" : "none",
                  transition: "all 0.2s",
                }}
              >
                {done ? (
                  <Check size={11} color="#fff" strokeWidth={3} />
                ) : (
                  <span
                    className="font-mono"
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      color: current ? "var(--led-blue)" : "var(--hw-text-dim)",
                    }}
                  >
                    {i + 1}
                  </span>
                )}
              </div>
              <span
                className="font-mono"
                style={{
                  fontSize: 8,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  whiteSpace: "nowrap",
                  color: current ? "var(--led-blue)" : done ? "var(--hw-text-dim)" : "var(--hw-border-light)",
                }}
              >
                {label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div
                style={{
                  flex: 1,
                  height: 2,
                  background: done ? "var(--led-blue)" : "var(--hw-border-light)",
                  marginBottom: 16,
                  minWidth: 20,
                  transition: "background 0.3s",
                }}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

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
    <div className={`flex-1 p-6 ${step === "results" ? "flex flex-col overflow-hidden" : "overflow-auto"}`}>
      <Stepper currentStep={stepToIndex(step)} />
      {step !== "entry" && (
        <button
          onClick={handleBack}
          style={{ color: "var(--hw-text-dim)", fontSize: 13, marginBottom: 16, cursor: "pointer", background: "none", border: "none" }}
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
        <p style={{ color: "var(--hw-text-dim)", fontSize: 13, textAlign: "center", marginTop: 40 }}>
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
        <>
          <div style={{ flexShrink: 0, width: "100%" }}>
            <SimilarityGraph
              tracks={expandResponse.tracks}
              edges={expandResponse.similarity_edges}
              seedIds={seedIds}
              onLike={() => {}}
              onDislike={() => {}}
            />
          </div>
          <div style={{ flex: 1, overflowY: "auto", marginTop: 12, minHeight: 0 }}>
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
