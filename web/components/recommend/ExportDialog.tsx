"use client";

import { useState } from "react";
import { X, Download } from "lucide-react";
import { exportPlaylist } from "@/lib/api";
import { toast } from "sonner";

interface ExportDialogProps {
  sessionId: string;
  defaultName: string;
  onClose: () => void;
}

const FORMATS = [
  { value: "rekordbox", label: "Rekordbox XML", ext: ".xml" },
  { value: "traktor", label: "Traktor NML", ext: ".nml" },
  { value: "m3u", label: "M3U Playlist", ext: ".m3u" },
  { value: "csv", label: "CSV", ext: ".csv" },
];

export default function ExportDialog({ sessionId, defaultName, onClose }: ExportDialogProps) {
  const [name, setName] = useState(defaultName);
  const [format, setFormat] = useState("rekordbox");
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await exportPlaylist(sessionId, format, name);
      const ext = FORMATS.find(f => f.value === format)?.ext || "";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Playlist exported!");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 50,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: "var(--hw-panel)", border: "1px solid var(--hw-border)",
        borderRadius: 12, padding: 24, width: 400,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ color: "var(--hw-text)", fontFamily: "var(--font-sans)", fontSize: 16, margin: 0 }}>Export Playlist</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}>
            <X size={18} color="var(--hw-text-dim)" />
          </button>
        </div>

        <label style={{ color: "var(--hw-text-dim)", fontSize: 12, display: "block", marginBottom: 4 }}>Playlist Name</label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: 8,
            background: "var(--hw-surface)", border: "1px solid var(--hw-border)",
            color: "var(--hw-text)", fontSize: 13, marginBottom: 16,
          }}
        />

        <label style={{ color: "var(--hw-text-dim)", fontSize: 12, display: "block", marginBottom: 8 }}>Format</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
          {FORMATS.map(f => (
            <button key={f.value} onClick={() => setFormat(f.value)} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
              borderRadius: 8, cursor: "pointer", textAlign: "left",
              background: format === f.value ? "var(--led-blue-mid)" : "var(--hw-surface)",
              border: format === f.value ? "2px solid var(--led-blue)" : "1px solid var(--hw-border)",
              color: format === f.value ? "#fff" : "var(--hw-text)",
              fontSize: 13,
            }}>
              {f.label}
            </button>
          ))}
        </div>

        <button onClick={handleExport} disabled={exporting || !name} style={{
          width: "100%", padding: "10px 0", borderRadius: 8,
          background: "var(--led-green)", color: "#000", fontSize: 14, fontWeight: 600,
          border: "none", cursor: exporting ? "wait" : "pointer",
          opacity: exporting ? 0.6 : 1,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        }}>
          <Download size={16} /> {exporting ? "Exporting..." : "Download"}
        </button>
      </div>
    </div>
  );
}
