"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchMoodPresets, type MoodPreset } from "@/lib/api";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";
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
      <h2 style={{ color: HARDWARE.text, fontFamily: FONTS.sans, fontSize: 18, marginBottom: 16 }}>
        Select a Mood
      </h2>
      {Object.entries(grouped).map(([cat, items]) => (
        <div key={cat} style={{ marginBottom: 16 }}>
          <div style={{ color: HARDWARE.textDim, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
            {CATEGORY_LABELS[cat] || cat}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {items.map(p => (
              <button key={p.id} onClick={() => setSelected(p.id)} style={{
                padding: "8px 16px", borderRadius: 8, cursor: "pointer",
                background: selected === p.id ? LED_COLORS.orange.mid : HARDWARE.surface,
                border: selected === p.id ? `2px solid ${LED_COLORS.orange.on}` : `1px solid ${HARDWARE.border}`,
                color: selected === p.id ? "#fff" : HARDWARE.text,
                fontSize: 13,
              }}>
                {p.name}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div style={{ borderTop: `1px solid ${HARDWARE.border}`, paddingTop: 12, marginTop: 8 }}>
        <div style={{ color: LED_COLORS.orange.on, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
          Lineup position
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {LINEUP_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => setLineup(opt.value)} style={{
              flex: 1, padding: "8px 16px", borderRadius: 8, textAlign: "center", cursor: "pointer",
              background: HARDWARE.surface,
              border: lineup === opt.value ? `2px solid ${LED_COLORS.blue.on}` : `1px solid ${HARDWARE.border}`,
              color: lineup === opt.value ? LED_COLORS.blue.on : HARDWARE.text,
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
          background: selected ? LED_COLORS.blue.on : HARDWARE.raised,
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
