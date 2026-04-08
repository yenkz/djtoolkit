"use client";

import { MapPin, Sliders } from "lucide-react";

interface EntryScreenProps {
  onSelectVenue: () => void;
  onSelectMood: () => void;
}

export default function EntryScreen({ onSelectVenue, onSelectMood }: EntryScreenProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24, paddingTop: 80 }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ color: "var(--hw-text)", fontFamily: "var(--font-sans)", fontSize: 24, fontWeight: 600, margin: 0 }}>
          Build Your Set
        </h1>
        <p style={{ color: "var(--hw-text-dim)", fontSize: 14, marginTop: 4 }}>
          Choose how you want to explore your library
        </p>
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        <button
          onClick={onSelectVenue}
          style={{
            background: "var(--hw-panel)", border: "2px solid var(--led-blue-mid)",
            borderRadius: 12, padding: 24, width: 280, cursor: "pointer", textAlign: "left",
          }}
        >
          <MapPin size={28} color="var(--led-blue)" />
          <div style={{ color: "var(--hw-text)", fontSize: 16, fontWeight: 600, marginTop: 8 }}>By Venue</div>
          <p style={{ color: "var(--hw-text-dim)", fontSize: 13, marginTop: 6 }}>
            Pick a club &mdash; we&apos;ll pre-fill the vibe, genres, and energy based on the venue profile
          </p>
          <div style={{ color: "var(--led-blue)", fontSize: 12, marginTop: 12 }}>
            Spain &middot; Argentina &middot; more coming
          </div>
        </button>
        <button
          onClick={onSelectMood}
          style={{
            background: "var(--hw-panel)", border: "2px solid var(--led-orange-mid)",
            borderRadius: 12, padding: 24, width: 280, cursor: "pointer", textAlign: "left",
          }}
        >
          <Sliders size={28} color="var(--led-orange)" />
          <div style={{ color: "var(--hw-text)", fontSize: 16, fontWeight: 600, marginTop: 8 }}>By Vibe &amp; Mood</div>
          <p style={{ color: "var(--hw-text-dim)", fontSize: 13, marginTop: 6 }}>
            Custom selection &mdash; pick mood, energy, genres, and lineup position yourself
          </p>
          <div style={{ color: "var(--led-orange)", fontSize: 12, marginTop: 12 }}>
            Beach &middot; Pool Party &middot; Night Club &middot; Coffee Rave...
          </div>
        </button>
      </div>
    </div>
  );
}
