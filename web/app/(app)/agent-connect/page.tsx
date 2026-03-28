"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function AgentConnectPage() {
  const [status, setStatus] = useState<"idle" | "connecting" | "done" | "error">("idle");
  const [error, setError] = useState("");

  const handleConnect = async () => {
    setStatus("connecting");
    setError("");
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in — please log in first.");

      const res = await fetch("/api/agents/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ machine_name: navigator.userAgent.slice(0, 64) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      const data = await res.json();
      const params = new URLSearchParams({
        api_key: data.api_key ?? "",
        supabase_url: data.supabase_url ?? "",
        supabase_anon_key: data.supabase_anon_key ?? "",
        agent_email: data.agent_email ?? "",
        agent_password: data.agent_password ?? "",
      });
      setStatus("done");
      // Redirect to the desktop app via custom URL scheme.
      // The browser will show an "Open application?" prompt.
      window.location.href = `djtoolkit://configure?${params.toString()}`;
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  };

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="mb-2 text-2xl font-bold">Connect Desktop Agent</h1>
      <p className="mb-8 text-gray-500">
        Click the button below to link the djtoolkit desktop agent to your account.
        You will be prompted to open the djtoolkit app.
      </p>

      {status === "done" ? (
        <p className="text-green-600">
          Done! Switch back to the djtoolkit app to finish setup.
        </p>
      ) : (
        <button
          onClick={handleConnect}
          disabled={status === "connecting"}
          className="rounded-lg bg-indigo-600 px-6 py-3 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {status === "connecting" ? "Connecting…" : "Connect Agent"}
        </button>
      )}

      {status === "error" && (
        <p className="mt-4 text-red-500 text-sm">{error}</p>
      )}

      <p className="mt-8 text-xs text-gray-400">
        Each click registers a new agent. To manage existing agents, visit{" "}
        <a href="/agents" className="underline">
          Agents
        </a>
        .
      </p>
    </div>
  );
}
