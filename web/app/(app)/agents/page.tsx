"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { fetchAgents, registerAgent, deleteAgent, type Agent } from "@/lib/api";
import Tag from "@/components/ui/Tag";
import StatusDot from "@/components/ui/StatusDot";

const CLOUD_URL = typeof window !== "undefined" ? window.location.origin : "";

function relativeTime(iso: string): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function agentStatus(lastSeen: string): "active" | "inactive" {
  if (!lastSeen) return "inactive";
  return Date.now() - new Date(lastSeen).getTime() < 120_000 ? "active" : "inactive";
}

/* ── Agent Row ─────────────────────────────────────────────────────────────── */

function AgentRow({
  agent,
  isLast,
  deleting,
  onDelete,
}: {
  agent: Agent;
  isLast: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const status = agentStatus(agent.last_seen_at);

  return (
    <div
      className="flex items-center gap-3.5 px-5 py-4 transition-colors duration-100 hover:bg-hw-list-row-hover"
      style={{
        borderBottom: isLast ? "none" : "1px solid var(--hw-list-border)",
        background: "var(--hw-list-row-bg)",
      }}
    >
      <StatusDot status={status} size={10} />

      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-bold text-hw-text">{agent.machine_name}</p>
        <p className="mt-0.5 text-xs text-hw-text-dim">
          Last seen {relativeTime(agent.last_seen_at)} · Registered{" "}
          {new Date(agent.created_at).toLocaleDateString()}
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
        {agent.capabilities?.map((cap) => (
          <Tag key={cap} label={cap} />
        ))}
      </div>

      <button
        onClick={onDelete}
        disabled={deleting}
        className="shrink-0 font-mono text-[11px] font-bold text-led-blue transition-colors duration-150 hover:text-led-red disabled:opacity-50"
      >
        Revoke
      </button>
    </div>
  );
}

/* ── Copy Button ───────────────────────────────────────────────────────────── */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="font-mono text-[10px] font-bold transition-colors duration-200"
      style={{
        color: copied ? "var(--led-green)" : "var(--hw-steel-text, #8A9AAA)",
        cursor: "pointer",
        padding: "3px 8px",
        borderRadius: 3,
      }}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

/* ── Code Block ────────────────────────────────────────────────────────────── */

function CodeBlock({ code }: { code: string }) {
  return (
    <div
      className="relative rounded-[5px] border border-hw-code-border bg-hw-code-bg transition-colors duration-200 hover:border-hw-border-light"
      style={{ padding: "14px 16px" }}
    >
      <code
        className="font-mono text-hw-text"
        style={{ fontSize: 12, lineHeight: 1.6, wordBreak: "break-all" }}
      >
        {code}
      </code>
      <span className="absolute right-2.5 top-2.5">
        <CopyButton text={code} />
      </span>
    </div>
  );
}

/* ── Wizard Steps ──────────────────────────────────────────────────────────── */

const WIZARD_LABELS = ["Install", "Generate Key", "Configure", "Start"];

function WizardSteps({ step }: { step: number }) {
  return (
    <div className="mb-6 flex items-center justify-center gap-1">
      {WIZARD_LABELS.map((label, i) => {
        const n = i + 1;
        const done = step > n;
        const active = step === n;

        return (
          <div key={n} className="flex items-center gap-1">
            {/* numbered circle */}
            <span
              className="flex items-center justify-center rounded-full font-mono text-[11px] font-bold"
              style={{
                width: 22,
                height: 22,
                background: done || active ? "var(--led-blue)" : "transparent",
                color: done || active ? "#fff" : "var(--hw-text-muted)",
                border: done || active ? "none" : "1.5px solid var(--hw-border-light)",
              }}
            >
              {done ? (
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 8 7 12 13 4" />
                </svg>
              ) : (
                n
              )}
            </span>

            {/* label */}
            <span
              className="text-[13px]"
              style={{
                fontWeight: active ? 700 : 400,
                color: active
                  ? "var(--hw-text)"
                  : done
                    ? "var(--hw-text-sec)"
                    : "var(--hw-text-muted)",
              }}
            >
              {label}
            </span>

            {/* arrow separator */}
            {i < WIZARD_LABELS.length - 1 && (
              <span className="mx-1 text-xs text-hw-text-muted">&rarr;</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Register Modal (multi-step wizard) ────────────────────────────────────── */

function AgentWizard({
  cloudUrl,
  onClose,
}: {
  cloudUrl: string;
  onClose: () => void;
}) {
  const [step, setStep] = useState(1);
  const [machineName, setMachineName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [registering, setRegistering] = useState(false);
  const [polling, setPolling] = useState(false);
  const [agentOnline, setAgentOnline] = useState(false);

  async function handleRegister() {
    if (!machineName.trim()) {
      toast.error("Enter a machine name");
      return;
    }
    setRegistering(true);
    try {
      const result = await registerAgent(machineName.trim());
      setApiKey(result.api_key);
      setStep(3);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setRegistering(false);
    }
  }

  function startPolling() {
    setStep(4);
    setPolling(true);
    const interval = setInterval(async () => {
      try {
        const agents = await fetchAgents();
        const found = agents.find(
          (a) =>
            a.machine_name === machineName &&
            a.last_seen_at &&
            Date.now() - new Date(a.last_seen_at).getTime() < 60_000
        );
        if (found) {
          setAgentOnline(true);
          setPolling(false);
          clearInterval(interval);
        }
      } catch {
        /* ignore */
      }
    }, 3000);
    return () => clearInterval(interval);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />

      {/* modal */}
      <div
        className="relative z-10 w-full overflow-hidden rounded-[10px] border border-hw-border-light shadow-2xl"
        style={{
          maxWidth: "clamp(380px, 45vw, 520px)",
          background: "var(--hw-modal-bg)",
        }}
      >
        <div style={{ padding: "24px 28px" }}>
          <WizardSteps step={step} />

          {/* ── Step 1: Install ────────────────────────────────────── */}
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-sm text-hw-text-sec">
                Install the djtoolkit agent on your macOS machine:
              </p>

              {/* Homebrew */}
              <div
                className="rounded-[6px] border border-hw-card-border bg-hw-card-bg"
                style={{ padding: "16px 18px" }}
              >
                <div className="mb-2.5 flex items-center gap-2">
                  <span className="text-sm font-bold text-hw-text">Homebrew</span>
                  <span
                    className="font-mono uppercase"
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      color: "var(--led-green)",
                      background: "rgba(68,255,68,0.08)",
                      padding: "2px 8px",
                      borderRadius: 3,
                      letterSpacing: 1,
                    }}
                  >
                    Recommended
                  </span>
                </div>
                <CodeBlock code="brew tap yenkz/djtoolkit && brew install djtoolkit" />
              </div>

              {/* Direct download */}
              <div
                className="rounded-[6px] border border-hw-card-border bg-hw-card-bg"
                style={{ padding: "16px 18px" }}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-bold text-hw-text">Direct download</span>
                  <a
                    href="https://github.com/yenkz/djtoolkit/releases/latest"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-[5px] border border-hw-border-light px-4 py-1.5 font-mono text-[11px] font-bold tracking-wide text-hw-text-dim transition-colors hover:border-led-blue/30 hover:text-led-blue"
                  >
                    GitHub Releases
                  </a>
                </div>
                <p className="text-xs text-hw-text-dim">
                  Download the .dmg from the latest release (arm64 + x86_64)
                </p>
              </div>

              {/* pip */}
              <div
                className="rounded-[6px] border border-hw-card-border bg-hw-card-bg"
                style={{ padding: "16px 18px" }}
              >
                <p className="mb-2 text-xs text-hw-text-dim">Or install via pip:</p>
                <CodeBlock code="pip install djtoolkit" />
              </div>

              <button
                onClick={() => setStep(2)}
                className="w-full rounded-[5px] bg-led-blue py-3 font-mono text-xs font-bold uppercase tracking-widest text-white transition-colors hover:bg-led-blue/85"
                style={{
                  boxShadow: "0 4px 12px rgba(68,136,255,0.3)",
                }}
              >
                Next: Generate API key
              </button>

              <div className="text-center">
                <button
                  onClick={onClose}
                  className="text-sm text-hw-text-dim transition-colors hover:text-hw-text"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* ── Step 2: Generate Key ──────────────────────────────── */}
          {step === 2 && (
            <div className="space-y-4">
              <p className="text-sm text-hw-text-sec">
                Name this machine so you can identify it later:
              </p>
              <input
                type="text"
                placeholder="e.g. MacBook Pro"
                value={machineName}
                onChange={(e) => setMachineName(e.target.value)}
                className="w-full rounded-[5px] border bg-hw-input-bg px-4 py-3 text-sm text-hw-text placeholder:text-hw-text-muted focus:outline-none"
                style={{
                  borderColor: machineName
                    ? "rgba(68,136,255,0.27)"
                    : "var(--hw-input-border)",
                  boxShadow: machineName
                    ? "0 0 0 3px rgba(68,136,255,0.07)"
                    : "none",
                  transition: "border-color 0.2s, box-shadow 0.2s",
                }}
              />
              <button
                onClick={handleRegister}
                disabled={registering}
                className="w-full rounded-[5px] bg-led-blue py-3 font-mono text-xs font-bold uppercase tracking-widest text-white transition-colors hover:bg-led-blue/85 disabled:opacity-50"
                style={{
                  boxShadow: "0 4px 12px rgba(68,136,255,0.3)",
                }}
              >
                {registering ? "Generating..." : "Generate API Key"}
              </button>

              <div className="text-center">
                <button
                  onClick={onClose}
                  className="text-sm text-hw-text-dim transition-colors hover:text-hw-text"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3: Configure ─────────────────────────────────── */}
          {step === 3 && (
            <div className="space-y-4">
              {/* Warning box */}
              <div
                className="rounded-[5px] px-3.5 py-2.5 text-sm"
                style={{
                  background: "rgba(255,160,51,0.08)",
                  border: "1px solid rgba(255,160,51,0.2)",
                  color: "var(--led-orange)",
                }}
              >
                <span className="mr-1.5">&#9888;</span>
                This key is shown <strong>once</strong>. Copy it now — you cannot
                retrieve it again.
              </div>

              <CodeBlock code={apiKey} />

              <p className="text-sm text-hw-text-sec">Run these on your machine:</p>

              <div className="flex flex-col gap-2.5">
                <CodeBlock
                  code={`djtoolkit agent configure --cloud-url ${cloudUrl} --api-key ${apiKey}`}
                />
                <CodeBlock code="djtoolkit agent install" />
              </div>

              <button
                onClick={startPolling}
                className="w-full rounded-[5px] bg-led-blue py-3 font-mono text-xs font-bold uppercase tracking-widest text-white transition-colors hover:bg-led-blue/85"
                style={{
                  boxShadow: "0 4px 12px rgba(68,136,255,0.3)",
                }}
              >
                Next: Start agent
              </button>

              <div className="text-center">
                <button
                  onClick={onClose}
                  className="text-sm text-hw-text-dim transition-colors hover:text-hw-text"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* ── Step 4: Start & Verify ────────────────────────────── */}
          {step === 4 && (
            <div className="space-y-4">
              <p className="text-sm text-hw-text-sec">
                Start the agent on your machine:
              </p>
              <CodeBlock code="djtoolkit agent start" />

              {/* Connection status indicator */}
              <div
                className="flex items-center gap-2.5 rounded-[5px] px-4 py-3"
                style={{
                  background: agentOnline
                    ? "rgba(68,255,68,0.07)"
                    : "rgba(255,160,51,0.07)",
                  border: `1px solid ${
                    agentOnline
                      ? "rgba(68,255,68,0.2)"
                      : "rgba(255,160,51,0.2)"
                  }`,
                }}
              >
                <StatusDot
                  status={agentOnline ? "connected" : "waiting"}
                  size={10}
                  className={!agentOnline && polling ? "animate-pulse" : ""}
                />
                <span
                  className="text-sm font-medium"
                  style={{
                    color: agentOnline
                      ? "var(--led-green)"
                      : "var(--led-orange)",
                  }}
                >
                  {agentOnline
                    ? "Agent connected!"
                    : "Waiting for agent to connect..."}
                </span>
              </div>

              {agentOnline ? (
                <button
                  onClick={onClose}
                  className="w-full rounded-[5px] bg-led-blue py-3 font-mono text-xs font-bold uppercase tracking-widest text-white transition-colors hover:bg-led-blue/85"
                  style={{
                    boxShadow: "0 4px 12px rgba(68,136,255,0.3)",
                  }}
                >
                  Done
                </button>
              ) : (
                <button
                  onClick={onClose}
                  className="w-full rounded-[5px] border border-hw-border-light py-3 font-mono text-[11px] font-bold tracking-wide text-hw-text-dim transition-colors hover:text-hw-text"
                >
                  Close anyway
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────────────────────────────── */

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

  useEffect(() => {
    load();
  }, [load]);

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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-[28px] font-black tracking-tight text-hw-text" style={{ letterSpacing: -1 }}>
          Agents
        </h1>
        <button
          onClick={() => setShowWizard(true)}
          className="rounded-[5px] bg-led-blue px-6 py-3 font-mono text-xs font-bold uppercase tracking-widest text-white transition-colors hover:bg-led-blue/85"
          style={{
            boxShadow: "0 4px 12px rgba(68,136,255,0.3)",
          }}
        >
          Register new agent
        </button>
      </div>

      {/* Agent list */}
      {loading ? (
        <p className="text-sm text-hw-text-dim">Loading...</p>
      ) : agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hw-border p-10 text-center">
          <p className="text-hw-text-dim">No agents registered yet.</p>
          <p className="mt-1 text-sm text-hw-text-dim">
            Register an agent to start downloading music.
          </p>
        </div>
      ) : (
        <div
          className="overflow-hidden rounded-[6px] border bg-hw-list-bg"
          style={{
            borderColor: "var(--hw-list-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
          }}
        >
          {agents.map((agent, i) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              isLast={i === agents.length - 1}
              deleting={deleting === agent.id}
              onDelete={() => handleDelete(agent.id)}
            />
          ))}
        </div>
      )}

      {/* Helper text */}
      {!loading && agents.length > 0 && (
        <p className="text-[13px] text-hw-text-muted">
          Agents run on your machine and handle downloading, fingerprinting, and tagging.
          Install via{" "}
          <code className="font-mono text-xs" style={{ color: "var(--hw-steel-text, #8A9AAA)" }}>
            brew install djtoolkit
          </code>{" "}
          or download from GitHub.
        </p>
      )}

      {/* Registration wizard modal */}
      {showWizard && (
        <AgentWizard
          cloudUrl={CLOUD_URL}
          onClose={() => {
            setShowWizard(false);
            load();
          }}
        />
      )}
    </div>
  );
}
