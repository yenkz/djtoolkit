import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import Button from "../components/Button";

type LogLevel = "ALL" | "ERROR" | "WARN" | "INFO" | "DEBUG";

const LOG_LEVELS: LogLevel[] = ["ALL", "ERROR", "WARN", "INFO", "DEBUG"];

type Category = "Agent" | "Soulseek" | "Jobs" | "HTTP" | "App";

const CATEGORIES: Category[] = ["Agent", "Soulseek", "Jobs", "HTTP", "App"];

const CATEGORY_COLORS: Record<Category, string> = {
  Agent: "#4caf50",
  Soulseek: "#ff9800",
  Jobs: "#2196f3",
  HTTP: "#888",
  App: "#e94560",
};

function getLineLevel(line: string): LogLevel {
  const upper = line.toUpperCase();
  if (upper.includes("[ERROR]") || upper.includes(" ERROR ")) return "ERROR";
  if (upper.includes("[WARN]") || upper.includes(" WARN ")) return "WARN";
  if (upper.includes("[DEBUG]") || upper.includes(" DEBUG ")) return "DEBUG";
  return "INFO";
}

function getLineCategory(line: string): Category | null {
  // App: lines starting with [unix_timestamp — Tauri app log
  if (/^\[17\d{3}/.test(line)) return "App";

  // HTTP: httpx logger
  if (line.includes("httpx:")) return "HTTP";

  // Agent: daemon, client, heartbeat
  if (
    line.includes("djtoolkit.agent.daemon") ||
    line.includes("djtoolkit.agent.client") ||
    line.includes("agents/heartbeat")
  )
    return "Agent";

  // Jobs: executor, pipeline/jobs, job_type, Claimed, Batch
  if (
    line.includes("djtoolkit.agent.executor") ||
    line.includes("pipeline/jobs") ||
    line.includes("job_type") ||
    line.includes("Claimed") ||
    line.includes("Batch")
  )
    return "Jobs";

  // Soulseek: aioslsk, soulseek, downloader
  if (
    line.includes("aioslsk") ||
    line.toLowerCase().includes("soulseek") ||
    line.includes("djtoolkit.downloader")
  )
    return "Soulseek";

  return null;
}

function getLineClass(level: LogLevel): string {
  switch (level) {
    case "ERROR": return "log-error";
    case "WARN": return "log-warn";
    case "DEBUG": return "log-debug";
    default: return "log-info";
  }
}

// Default: all categories selected except HTTP (noisy heartbeat/poll logs)
const DEFAULT_CATEGORIES = new Set<Category | "ALL">(
  CATEGORIES.filter((c) => c !== "HTTP") as (Category | "ALL")[]
);

export default function LogViewer() {
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState<LogLevel>("ALL");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [activeCategories, setActiveCategories] = useState<Set<Category | "ALL">>(
    () => new Set(DEFAULT_CATEGORIES)
  );
  const containerRef = useRef<HTMLDivElement>(null);

  const toggleCategory = useCallback((cat: Category | "ALL") => {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (cat === "ALL") {
        // Toggle ALL: if ALL is active, deselect everything; otherwise select all
        if (next.has("ALL")) {
          next.clear();
        } else {
          next.add("ALL");
          CATEGORIES.forEach((c) => next.add(c));
        }
      } else {
        if (next.has(cat)) {
          next.delete(cat);
          next.delete("ALL"); // deselecting any individual removes ALL
        } else {
          next.add(cat);
          // If all individual categories are now selected, add ALL
          if (CATEGORIES.every((c) => next.has(c))) {
            next.add("ALL");
          }
        }
      }
      return next;
    });
  }, []);

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

  const clearLogs = async () => {
    try {
      await invoke("clear_log_file");
    } catch {
      // Best-effort — still clear the UI
    }
    setLines([]);
  };

  const nonEmptyLines = lines.filter((line) => line.trim());

  const filteredLines = nonEmptyLines.filter((line) => {
    if (filter !== "ALL" && getLineLevel(line) !== filter) return false;
    if (search && !line.toLowerCase().includes(search.toLowerCase())) return false;
    // Category filter
    if (!activeCategories.has("ALL")) {
      const cat = getLineCategory(line);
      if (cat && !activeCategories.has(cat)) return false;
      // Lines with no detected category pass through (uncategorized)
    }
    return true;
  });

  const activeFilterNames: string[] = [];
  if (filter !== "ALL") activeFilterNames.push(filter);
  if (!activeCategories.has("ALL")) {
    const activeCats = CATEGORIES.filter((c) => activeCategories.has(c));
    if (activeCats.length > 0 && activeCats.length < CATEGORIES.length) {
      activeFilterNames.push(activeCats.join(", "));
    }
  }
  if (search) activeFilterNames.push(`"${search}"`);

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
          <Button variant="secondary" size="small" onClick={clearLogs}>
            Clear
          </Button>
        </div>
      </div>

      <div className="log-category-bar">
        <div className="log-category-chips">
          <button
            className={`log-category-chip ${activeCategories.has("ALL") ? "active" : ""}`}
            style={{
              "--chip-color": "var(--text-muted)",
            } as React.CSSProperties}
            onClick={() => toggleCategory("ALL")}
          >
            ALL
          </button>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`log-category-chip ${activeCategories.has(cat) ? "active" : ""}`}
              style={{
                "--chip-color": CATEGORY_COLORS[cat],
              } as React.CSSProperties}
              onClick={() => toggleCategory(cat)}
            >
              <span
                className="log-category-dot"
                style={{ background: CATEGORY_COLORS[cat] }}
              />
              {cat}
            </button>
          ))}
        </div>
        <span className="log-showing">
          Showing {filteredLines.length} of {nonEmptyLines.length} lines
          {activeFilterNames.length > 0 && (
            <span className="log-showing-filters">
              {" "}— filtered by {activeFilterNames.join(" + ")}
            </span>
          )}
        </span>
      </div>

      <div
        className="log-container"
        ref={containerRef}
        onScroll={handleScroll}
      >
        {filteredLines.map((line, i) => {
          const level = getLineLevel(line);
          const category = getLineCategory(line);
          return (
            <div key={i} className={`log-line ${getLineClass(level)}`}>
              {category && (
                <span
                  className="log-line-badge"
                  style={{
                    background: CATEGORY_COLORS[category],
                  }}
                >
                  {category}
                </span>
              )}
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
