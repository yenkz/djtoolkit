"use client";

import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import { fetchPipelineStatus, type PipelineStatus } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

function agentStatusColor(lastSeen: string): string {
  const diff = Date.now() - new Date(lastSeen).getTime();
  if (diff < 2 * 60 * 1000) return "bg-green-500";
  if (diff < 10 * 60 * 1000) return "bg-yellow-500";
  return "bg-red-500";
}

function relativeTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function PipelinePage() {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const sseRef = useRef<EventSource | null>(null);

  async function load() {
    try {
      setStatus(await fetchPipelineStatus());
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to load pipeline status");
    }
  }

  useEffect(() => {
    load();

    // SSE for real-time updates
    (async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      // SSE doesn't support custom headers — pass token as query param
      const url = `${API_URL}/pipeline/events?token=${session.access_token}`;
      const es = new EventSource(url);
      sseRef.current = es;

      es.onmessage = (e) => {
        const data = JSON.parse(e.data);
        setEvents((prev) => [`${new Date().toLocaleTimeString()} — ${data.type}: ${JSON.stringify(data.data)}`, ...prev.slice(0, 49)]);
        if (data.type === "job_update" || data.type === "agent_heartbeat") {
          load();
        }
      };
      es.onerror = () => es.close();
    })();

    return () => sseRef.current?.close();
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-white">Pipeline</h1>

      {status && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            { label: "Pending jobs", value: status.pending },
            { label: "Running jobs", value: status.running },
            { label: "Active agents", value: status.agents.length },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <p className="text-3xl font-bold text-white">{value}</p>
              <p className="text-sm text-gray-500">{label}</p>
            </div>
          ))}
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-gray-400 uppercase tracking-wider">Agents</h2>
        {!status || status.agents.length === 0 ? (
          <p className="text-sm text-gray-500">No agents registered. Go to Agents to set one up.</p>
        ) : (
          <div className="space-y-2">
            {status.agents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-4 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
                <span className={`h-2.5 w-2.5 rounded-full ${agentStatusColor(agent.last_seen_at)}`} />
                <div className="flex-1">
                  <p className="font-medium text-white">{agent.machine_name}</p>
                  <p className="text-xs text-gray-500">Last seen {relativeTime(agent.last_seen_at)}</p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {agent.capabilities.map((cap) => (
                    <span key={cap} className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">{cap}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {events.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-gray-400 uppercase tracking-wider">Live Events</h2>
          <div className="rounded-lg border border-gray-800 bg-gray-950 p-3 font-mono text-xs text-gray-400 space-y-1 max-h-48 overflow-y-auto">
            {events.map((e, i) => <p key={i}>{e}</p>)}
          </div>
        </section>
      )}
    </div>
  );
}
