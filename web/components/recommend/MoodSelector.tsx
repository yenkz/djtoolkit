"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchMoodPresets, type MoodPreset } from "@/lib/api";
import { toast } from "sonner";

interface MoodSelectorProps {
  onGenerateSeeds: (moodPresetId: string, lineup: string) => void;
  loading: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  beach: "Beach", pool_party: "Pool Party", nightclub: "Nightclub",
  day_party: "Day Party", coffee_rave: "Coffee Rave", afterhours: "Afterhours",
};

const LINEUP_OPTIONS = [
  { value: "warmup", label: "Warm-up" },
  { value: "middle", label: "Middle" },
  { value: "headliner", label: "Headliner" },
];

export default function MoodSelector({ onGenerateSeeds, loading }: MoodSelectorProps) {
  const [presets, setPresets] = useState<MoodPreset[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [lineup, setLineup] = useState("middle");

  const load = useCallback(async () => {
    try {
      const data = await fetchMoodPresets();
      setPresets(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load moods");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const grouped = presets.reduce<Record<string, MoodPreset[]>>((acc, p) => {
    (acc[p.category] ??= []).push(p);
    return acc;
  }, {});

  return (
    <div style={{ maxWidth: 500, margin: "0 auto" }}>
      <h2 style={{ color: "var(--hw-text)", fontFamily: "var(--font-sans)", fontSize: 18, marginBottom: 16 }}>
        Select a Mood
      </h2>
      {Object.entries(grouped).map(([cat, items]) => (
        <div key={cat} style={{ marginBottom: 16 }}>
          <div style={{ color: "var(--hw-text-dim)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
            {CATEGORY_LABELS[cat] || cat}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {items.map(p => (
              <button key={p.id} onClick={() => setSelected(p.id)} style={{
                padding: "8px 16px", borderRadius: 8, cursor: "pointer",
                background: selected === p.id ? "var(--led-orange-mid)" : "var(--hw-surface)",
                border: selected === p.id ? "2px solid var(--led-orange)" : "1px solid var(--hw-border)",
                color: selected === p.id ? "#fff" : "var(--hw-text)",
                fontSize: 13,
              }}>
                {p.name}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div style={{ borderTop: "1px solid var(--hw-border)", paddingTop: 12, marginTop: 8 }}>
        <div style={{ color: "var(--led-orange)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
          Lineup position
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {LINEUP_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => setLineup(opt.value)} style={{
              flex: 1, padding: "8px 16px", borderRadius: 8, textAlign: "center", cursor: "pointer",
              background: "var(--hw-surface)",
              border: lineup === opt.value ? "2px solid var(--led-blue)" : "1px solid var(--hw-border)",
              color: lineup === opt.value ? "var(--led-blue)" : "var(--hw-text)",
              fontSize: 13,
            }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => selected && onGenerateSeeds(selected, lineup)}
        disabled={!selected || loading}
        style={{
          width: "100%", marginTop: 16, padding: "10px 0", borderRadius: 8,
          background: selected ? "var(--led-blue)" : "var(--hw-raised)",
          color: "#fff", fontSize: 14, fontWeight: 600,
          border: "none", cursor: !selected || loading ? "default" : "pointer",
          opacity: !selected || loading ? 0.5 : 1,
        }}
      >
        {loading ? "Generating..." : "Generate Seeds \u2192"}
      </button>
    </div>
  );
}
