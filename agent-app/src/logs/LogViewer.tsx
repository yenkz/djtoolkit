import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import Button from "../components/Button";

type LogLevel = "ALL" | "ERROR" | "WARN" | "INFO" | "DEBUG";

const LOG_LEVELS: LogLevel[] = ["ALL", "ERROR", "WARN", "INFO", "DEBUG"];

function getLineLevel(line: string): LogLevel {
  const upper = line.toUpperCase();
  if (upper.includes("[ERROR]") || upper.includes(" ERROR ")) return "ERROR";
  if (upper.includes("[WARN]") || upper.includes(" WARN ")) return "WARN";
  if (upper.includes("[DEBUG]") || upper.includes(" DEBUG ")) return "DEBUG";
  return "INFO";
}

function getLineClass(level: LogLevel): string {
  switch (level) {
    case "ERROR": return "log-error";
    case "WARN": return "log-warn";
    case "DEBUG": return "log-debug";
    default: return "log-info";
  }
}

export default function LogViewer() {
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState<LogLevel>("ALL");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const content = await invoke<string>("get_log_content", { lines: 500 });
      setLines(content.split("\n"));
    } catch {
      // Backend may not be ready yet
    }
  }, []);

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const jumpToBottom = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setAutoScroll(true);
    }
  };

  const clearLogs = () => {
    setLines([]);
  };

  const filteredLines = lines.filter((line) => {
    if (!line.trim()) return false;
    if (filter !== "ALL" && getLineLevel(line) !== filter) return false;
    if (search && !line.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="log-viewer">
      <div className="log-toolbar">
        <div className="log-filters">
          {LOG_LEVELS.map((level) => (
            <button
              key={level}
              className={`log-filter-btn ${filter === level ? "active" : ""}`}
              onClick={() => setFilter(level)}
            >
              {level}
            </button>
          ))}
        </div>

        <div className="log-search">
          <input
            type="text"
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            className="log-search-input"
          />
        </div>

        <div className="log-actions">
          <span className="log-count">{filteredLines.length} lines</span>
          <Button variant="secondary" size="small" onClick={clearLogs}>
            Clear
          </Button>
        </div>
      </div>

      <div
        className="log-container"
        ref={containerRef}
        onScroll={handleScroll}
      >
        {filteredLines.map((line, i) => {
          const level = getLineLevel(line);
          return (
            <div key={i} className={`log-line ${getLineClass(level)}`}>
              {line}
            </div>
          );
        })}
        {filteredLines.length === 0 && (
          <div className="log-empty">No log entries to display</div>
        )}
      </div>

      {!autoScroll && (
        <button className="log-jump-btn" onClick={jumpToBottom}>
          Jump to bottom
        </button>
      )}
    </div>
  );
}
