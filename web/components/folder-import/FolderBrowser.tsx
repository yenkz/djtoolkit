// web/components/folder-import/FolderBrowser.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { sendAgentCommand, getAgentCommandResult } from "@/lib/api";
import ActionButton from "@/components/ui/ActionButton";

interface FileEntry {
  name: string;
  type: "file" | "dir";
  size_bytes: number | null;
  extension: string | null;
}

interface FolderBrowserProps {
  agentId: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FolderBrowser({ agentId, onSelect, onClose }: FolderBrowserProps) {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(
    async (path?: string) => {
      setLoading(true);
      setError(null);
      try {
        const { id } = await sendAgentCommand(agentId, "browse_folder", {
          path: path ?? null,
        });

        // Poll for result
        let attempts = 0;
        while (attempts < 30) {
          await new Promise((r) => setTimeout(r, 500));
          const cmd = await getAgentCommandResult(id);
          if (cmd.status === "completed" && cmd.result) {
            const r = cmd.result as {
              path: string;
              parent: string | null;
              entries: FileEntry[];
            };
            setCurrentPath(r.path);
            setParentPath(r.parent);
            setEntries(r.entries);
            setLoading(false);
            return;
          }
          if (cmd.status === "failed") {
            setError(cmd.error ?? "Command failed");
            setLoading(false);
            return;
          }
          attempts++;
        }
        setError("Agent did not respond in time");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    },
    [agentId],
  );

  useEffect(() => {
    browse();
  }, [browse]);

  const audioCount = entries.filter((e) => e.type === "file").length;
  const dirCount = entries.filter((e) => e.type === "dir").length;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 59,
        }}
      />

      {/* Modal */}
      <div
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 60,
          background: "var(--hw-surface)",
          border: "1px solid var(--hw-border-light)",
          borderRadius: 10,
          width: 540,
          maxHeight: 520,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--hw-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span
            className="font-mono"
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 2,
              color: "var(--hw-text-secondary)",
            }}
          >
            Browse Agent Filesystem
          </span>
          <button onClick={onClose} className="font-mono" style={{ background: "none", border: "none", color: "var(--hw-text-muted)", cursor: "pointer", fontSize: 16 }}>
            &times;
          </button>
        </div>

        {/* Path bar */}
        <div
          style={{
            padding: "10px 20px",
            borderBottom: "1px solid var(--hw-border)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <button
            onClick={() => parentPath && browse(parentPath)}
            disabled={!parentPath || loading}
            className="font-mono"
            style={{
              background: "var(--hw-raised)",
              border: "1px solid var(--hw-border-light)",
              borderRadius: 5,
              color: "var(--hw-text-dim)",
              padding: "6px 10px",
              cursor: parentPath ? "pointer" : "not-allowed",
              fontSize: 11,
              fontWeight: 700,
              opacity: parentPath ? 1 : 0.4,
            }}
          >
            &#x25B2; Up
          </button>
          <div
            className="font-mono"
            style={{
              fontSize: 12,
              color: "var(--hw-text-dim)",
              background: "var(--hw-input-bg)",
              border: "1px solid var(--hw-input-border)",
              borderRadius: 5,
              padding: "6px 12px",
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {currentPath ?? "Loading..."}
          </div>
        </div>

        {/* File list */}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 200 }}>
          {loading && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--hw-text-muted)" }}>
              Browsing...
            </div>
          )}
          {error && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--hw-error-text)" }}>
              {error}
            </div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--hw-text-muted)" }}>
              Empty directory
            </div>
          )}
          {!loading &&
            !error &&
            entries.map((entry) => (
              <div
                key={entry.name}
                onClick={() => {
                  if (entry.type === "dir" && currentPath) {
                    browse(`${currentPath}/${entry.name}`);
                  }
                }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 80px 60px",
                  gap: 8,
                  alignItems: "center",
                  padding: "8px 20px",
                  borderBottom: "1px solid var(--hw-border)",
                  cursor: entry.type === "dir" ? "pointer" : "default",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--hw-card-hover)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <span
                  style={{
                    fontSize: 13,
                    color:
                      entry.type === "dir"
                        ? "var(--led-blue-on)"
                        : "var(--hw-text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {entry.type === "dir" ? "\u{1F4C1} " : "\u{1F3B5} "}
                  {entry.name}
                </span>
                <span
                  className="font-mono"
                  style={{
                    fontSize: 10,
                    color: "var(--hw-text-muted)",
                    textAlign: "right",
                  }}
                >
                  {entry.type === "dir" ? "" : formatSize(entry.size_bytes)}
                </span>
                <span
                  className="font-mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: 1,
                    color: "var(--hw-text-dim)",
                    textAlign: "right",
                  }}
                >
                  {entry.type === "dir" ? "DIR" : entry.extension}
                </span>
              </div>
            ))}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid var(--hw-border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span
            className="font-mono"
            style={{ fontSize: 10, color: "var(--hw-text-dim)" }}
          >
            {audioCount} audio file{audioCount !== 1 ? "s" : ""} &middot;{" "}
            {dirCount} folder{dirCount !== 1 ? "s" : ""}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <ActionButton variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </ActionButton>
            <ActionButton
              size="sm"
              onClick={() => currentPath && onSelect(currentPath)}
              disabled={!currentPath || audioCount === 0}
            >
              Import This Folder
            </ActionButton>
          </div>
        </div>
      </div>
    </>
  );
}
