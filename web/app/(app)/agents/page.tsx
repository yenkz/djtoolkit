"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { fetchAgents, registerAgent, deleteAgent, type Agent } from "@/lib/api";

const CLOUD_URL = typeof window !== "undefined" ? window.location.origin : "";

function relativeTime(iso: string): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAgents(await fetchAgents());
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to load agents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(id: string) {
    if (!confirm("Revoke this agent? It will stop working immediately.")) return;
    setDeleting(id);
    try {
      await deleteAgent(id);
      toast.success("Agent revoked");
      load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to delete agent");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-hw-text">Agents</h1>
        <button
          onClick={() => setShowWizard(true)}
          className="rounded-lg bg-led-blue px-3 py-1.5 text-sm font-medium text-hw-text hover:bg-led-blue/80"
        >
          Register new agent
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-hw-text-dim">Loading...</p>
      ) : agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hw-border p-10 text-center">
          <p className="text-hw-text-dim">No agents registered yet.</p>
          <p className="mt-1 text-sm text-hw-text-dim">Register an agent to start downloading music.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {agents.map((agent) => (
            <div key={agent.id} className="flex items-center gap-4 rounded-lg border border-hw-border bg-hw-surface px-4 py-3">
              <div className="flex-1">
                <p className="font-medium text-hw-text">{agent.machine_name}</p>
                <p className="text-xs text-hw-text-dim">
                  Last seen {relativeTime(agent.last_seen_at)} · Registered {new Date(agent.created_at).toLocaleDateString()}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {agent.capabilities?.map((cap) => (
                  <span key={cap} className="rounded bg-hw-raised px-2 py-0.5 text-xs text-hw-text-dim">{cap}</span>
                ))}
              </div>
              <button
                onClick={() => handleDelete(agent.id)}
                disabled={deleting === agent.id}
                className="rounded px-2 py-1 text-xs text-led-red hover:bg-led-red/10 disabled:opacity-50"
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}

      {showWizard && (
        <AgentWizard cloudUrl={CLOUD_URL} onClose={() => { setShowWizard(false); load(); }} />
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="rounded bg-hw-raised px-2 py-0.5 text-xs text-hw-text hover:bg-hw-raised/80"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative rounded-lg border border-hw-border bg-hw-body p-3">
      <pre className="font-mono text-sm text-led-green overflow-x-auto whitespace-pre-wrap break-all">{code}</pre>
      <div className="mt-2 flex justify-end">
        <CopyButton text={code} />
      </div>
    </div>
  );
}

function AgentWizard({ cloudUrl, onClose }: { cloudUrl: string; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [machineName, setMachineName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [registering, setRegistering] = useState(false);
  const [polling, setPolling] = useState(false);
  const [agentOnline, setAgentOnline] = useState(false);

  const STEPS = ["Install", "Generate Key", "Configure", "Start"];

  async function handleRegister() {
    if (!machineName.trim()) { toast.error("Enter a machine name"); return; }
    setRegistering(true);
    try {
      const result = await registerAgent(machineName.trim());
      setApiKey(result.api_key);
      setStep(2);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setRegistering(false);
    }
  }

  function startPolling() {
    setStep(3);
    setPolling(true);
    const interval = setInterval(async () => {
      try {
        const agents = await fetchAgents();
        const found = agents.find((a) => a.machine_name === machineName && a.last_seen_at &&
          Date.now() - new Date(a.last_seen_at).getTime() < 60_000);
        if (found) { setAgentOnline(true); setPolling(false); clearInterval(interval); }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-lg rounded-xl border border-hw-border bg-hw-surface p-6 shadow-2xl">
        <div className="mb-5 flex items-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${i <= step ? "bg-led-blue text-hw-text" : "bg-hw-raised text-hw-text-dim"}`}>{i + 1}</span>
              <span className={`text-sm ${i === step ? "text-hw-text font-medium" : "text-hw-text-dim"}`}>{s}</span>
              {i < STEPS.length - 1 && <span className="text-hw-border mx-1">&rarr;</span>}
            </div>
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-hw-text">Install the djtoolkit agent on your macOS machine:</p>

            {/* Homebrew (recommended) */}
            <div className="rounded-lg border border-led-blue bg-led-blue/10 p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-medium text-hw-text">Homebrew</span>
                <span className="rounded bg-led-blue/40 px-1.5 py-0.5 text-[10px] font-semibold text-led-blue uppercase">recommended</span>
              </div>
              <CodeBlock code="brew tap yenkz/djtoolkit && brew install djtoolkit" />
            </div>

            {/* Direct download */}
            <div className="rounded-lg border border-hw-border bg-hw-raised/50 p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-hw-text">Direct download</span>
                <a
                  href="https://github.com/yenkz/djtoolkit/releases/latest"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded bg-hw-raised px-2.5 py-1 text-xs font-medium text-hw-text hover:bg-hw-raised/80"
                >
                  GitHub Releases
                </a>
              </div>
              <p className="text-xs text-hw-text-dim">Download the .dmg from the latest release (arm64 + x86_64)</p>
            </div>

            {/* pip fallback */}
            <div className="rounded-lg border border-hw-border bg-hw-raised/50 p-3">
              <p className="text-xs text-hw-text-dim mb-1.5">Or install via pip:</p>
              <CodeBlock code="pip install djtoolkit" />
            </div>

            <button onClick={() => setStep(1)} className="w-full rounded-lg bg-led-blue py-2 text-sm font-medium text-hw-text hover:bg-led-blue/80">
              Next: Generate API key
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm text-hw-text">Name this machine so you can identify it later:</p>
            <input
              type="text"
              placeholder="e.g. MacBook Pro"
              value={machineName}
              onChange={(e) => setMachineName(e.target.value)}
              className="w-full rounded-lg border border-hw-border bg-hw-raised px-3 py-2 text-hw-text placeholder-hw-text-dim focus:border-led-blue focus:outline-none"
            />
            <button
              onClick={handleRegister}
              disabled={registering}
              className="w-full rounded-lg bg-led-blue py-2 text-sm font-medium text-hw-text hover:bg-led-blue/80 disabled:opacity-50"
            >
              {registering ? "Generating..." : "Generate API Key"}
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <div className="rounded-lg border border-led-orange/40 bg-led-orange/10 px-3 py-2 text-sm text-led-orange">
              This key is shown <strong>once</strong>. Copy it now — you cannot retrieve it again.
            </div>
            <CodeBlock code={apiKey} />
            <p className="text-sm text-hw-text">Run these on your machine:</p>
            <CodeBlock code={`djtoolkit agent configure --cloud-url ${cloudUrl} --api-key ${apiKey}`} />
            <CodeBlock code="djtoolkit agent install" />
            <button onClick={startPolling} className="w-full rounded-lg bg-led-blue py-2 text-sm font-medium text-hw-text hover:bg-led-blue/80">
              Next: Start agent
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <p className="text-sm text-hw-text">Start the agent on your machine:</p>
            <CodeBlock code="djtoolkit agent start" />
            <div className="flex items-center gap-3 rounded-lg border border-hw-border bg-hw-raised px-3 py-3">
              {agentOnline ? (
                <>
                  <span className="h-3 w-3 rounded-full bg-led-green" />
                  <p className="text-sm text-led-green font-medium">Agent connected!</p>
                </>
              ) : polling ? (
                <>
                  <span className="h-3 w-3 rounded-full bg-led-orange animate-pulse" />
                  <p className="text-sm text-hw-text-dim">Waiting for agent to connect...</p>
                </>
              ) : null}
            </div>
            <button
              onClick={onClose}
              disabled={polling && !agentOnline}
              className="w-full rounded-lg border border-hw-border py-2 text-sm text-hw-text hover:bg-hw-raised disabled:opacity-50"
            >
              {agentOnline ? "Done" : "Close anyway"}
            </button>
          </div>
        )}

        {step < 3 && (
          <button onClick={onClose} className="mt-3 w-full rounded py-1.5 text-sm text-hw-text-dim hover:text-hw-text">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
