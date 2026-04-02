"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import type { Venue } from "@/lib/api";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";

interface VenueDetailProps {
  venue: Venue;
  onGenerateSeeds: (lineup: string) => void;
  loading: boolean;
}

const LINEUP_OPTIONS = [
  { value: "warmup", label: "Warm-up" },
  { value: "middle", label: "Middle" },
  { value: "headliner", label: "Headliner" },
];

export default function VenueDetail({ venue, onGenerateSeeds, loading }: VenueDetailProps) {
  const [lineup, setLineup] = useState("middle");
  const profile = venue.target_profile as Record<string, number[]>;

  return (
    <div style={{ maxWidth: 500, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <div style={{ width: 80, height: 80, borderRadius: 8, background: HARDWARE.raised }} />
        <div>
          <h2 style={{ color: HARDWARE.text, fontFamily: FONTS.sans, fontSize: 18, margin: 0 }}>{venue.name}</h2>
          {venue.address && <div style={{ color: HARDWARE.textDim, fontSize: 12 }}>{venue.address}</div>}
          <div style={{ color: HARDWARE.textDim, fontSize: 12 }}>{venue.city}, {venue.country}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
            {venue.google_rating && (
              <span style={{ color: "#fbbf24", fontSize: 12, display: "flex", alignItems: "center", gap: 2 }}>
                <Star size={12} fill="#fbbf24" /> {venue.google_rating}
              </span>
            )}
            <span style={{ color: HARDWARE.textDim, fontSize: 12 }}>
              {venue.type} {venue.capacity ? `\u00b7 ${venue.capacity} ppl` : ""}
            </span>
          </div>
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${HARDWARE.border}`, paddingTop: 12, marginBottom: 16 }}>
        <div style={{ color: LED_COLORS.blue.on, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
          Pre-filled from venue
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12 }}>
          {venue.genres?.length > 0 && (
            <div><span style={{ color: HARDWARE.textDim }}>Genres:</span> <span style={{ color: HARDWARE.text }}>{venue.genres.join(", ")}</span></div>
          )}
          {profile.bpm && (
            <div><span style={{ color: HARDWARE.textDim }}>BPM:</span> <span style={{ color: HARDWARE.text }}>{profile.bpm[0]} &ndash; {profile.bpm[1]}</span></div>
          )}
          {profile.energy && (
            <div><span style={{ color: HARDWARE.textDim }}>Energy:</span> <span style={{ color: HARDWARE.text }}>{profile.energy[0]} &ndash; {profile.energy[1]}</span></div>
          )}
          {venue.mood_tags?.length > 0 && (
            <div><span style={{ color: HARDWARE.textDim }}>Mood:</span> <span style={{ color: HARDWARE.text }}>{venue.mood_tags.join(", ")}</span></div>
          )}
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${HARDWARE.border}`, paddingTop: 12 }}>
        <div style={{ color: LED_COLORS.orange.on, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
          Your lineup position
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
        onClick={() => onGenerateSeeds(lineup)}
        disabled={loading}
        style={{
          width: "100%", marginTop: 16, padding: "10px 0", borderRadius: 8,
          background: LED_COLORS.blue.on, color: "#fff", fontSize: 14, fontWeight: 600,
          border: "none", cursor: loading ? "wait" : "pointer",
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? "Generating..." : "Generate Seeds \u2192"}
      </button>
    </div>
  );
}
