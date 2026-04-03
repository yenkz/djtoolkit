"use client";

import { useState, useEffect, useCallback } from "react";
import { Star } from "lucide-react";
import { fetchVenues, type Venue } from "@/lib/api";
import { HARDWARE, LED_COLORS, FONTS } from "@/lib/design-system/tokens";
import { toast } from "sonner";

interface VenueBrowserProps {
  onSelectVenue: (venue: Venue) => void;
}

const COUNTRIES = ["Spain", "Argentina"];

export default function VenueBrowser({ onSelectVenue }: VenueBrowserProps) {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [search, setSearch] = useState("");
  const [country, setCountry] = useState<string>(COUNTRIES[0]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchVenues(country);
      setVenues(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load venues");
    } finally {
      setLoading(false);
    }
  }, [country]);

  useEffect(() => { load(); }, [load]);

  const filtered = venues.filter(v =>
    !search || v.name.toLowerCase().includes(search.toLowerCase()) ||
    v.city.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ maxWidth: 600, margin: "0 auto" }}>
      <h2 style={{ color: HARDWARE.text, fontFamily: FONTS.sans, fontSize: 18, marginBottom: 12 }}>
        Select a Venue
      </h2>
      <input
        type="text"
        placeholder="Search venues..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{
          width: "100%", padding: "8px 12px", borderRadius: 8,
          background: HARDWARE.surface, border: `1px solid ${HARDWARE.border}`,
          color: HARDWARE.text, fontSize: 13, marginBottom: 8,
        }}
      />
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {COUNTRIES.map(c => (
          <button key={c} onClick={() => setCountry(c)} style={{
            padding: "3px 12px", borderRadius: 12, fontSize: 12, cursor: "pointer",
            background: country === c ? LED_COLORS.blue.mid : HARDWARE.raised,
            color: country === c ? "#fff" : HARDWARE.textDim,
            border: "none",
          }}>
            {c}
          </button>
        ))}
      </div>
      {loading ? (
        <p style={{ color: HARDWARE.textDim }}>Loading...</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(v => (
            <button key={v.id} onClick={() => onSelectVenue(v)} style={{
              display: "flex", gap: 12, alignItems: "center", padding: 12,
              background: HARDWARE.surface, border: `1px solid ${HARDWARE.border}`,
              borderRadius: 8, cursor: "pointer", textAlign: "left", width: "100%",
            }}>
              {v.photo_url ? (
                <img src={v.photo_url} alt={v.name} style={{ width: 48, height: 48, borderRadius: 6, objectFit: "cover" }} />
              ) : (
                <div style={{ width: 48, height: 48, borderRadius: 6, background: HARDWARE.raised, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: HARDWARE.textDim }}>
                  {v.type.slice(0, 3).toUpperCase()}
                </div>
              )}
              <div style={{ flex: 1 }}>
                <div style={{ color: HARDWARE.text, fontSize: 14, fontWeight: 600 }}>{v.name}</div>
                <div style={{ color: HARDWARE.textDim, fontSize: 12 }}>
                  {v.city} &middot; {v.type} {v.capacity ? `\u00b7 ${v.capacity} cap` : ""}
                </div>
                <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                  {v.genres?.slice(0, 3).map(g => (
                    <span key={g} style={{
                      background: "rgba(126,255,126,0.1)", color: LED_COLORS.green.on,
                      padding: "1px 6px", borderRadius: 4, fontSize: 10,
                    }}>
                      {g}
                    </span>
                  ))}
                </div>
              </div>
              {v.google_rating && (
                <div style={{ display: "flex", alignItems: "center", gap: 2, color: "#fbbf24", fontSize: 12 }}>
                  <Star size={12} fill="#fbbf24" /> {v.google_rating}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
