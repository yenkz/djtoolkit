import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppConfig } from "../types";
import Button from "../components/Button";
import Input from "../components/Input";
import Toggle from "../components/Toggle";

const CLOUD_URL = "https://www.djtoolkit.net";

type Section = "general" | "credentials" | "agent" | "account";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "general", label: "General" },
  { key: "credentials", label: "Credentials" },
  { key: "agent", label: "Agent" },
  { key: "account", label: "Account" },
];

const DEFAULT_CONFIG: AppConfig = {
  downloads_dir: "",
  launch_at_startup: true,
  api_key: "",
  slsk_username: "",
  poll_interval_sec: 30,
  max_concurrent_jobs: 2,
};

export default function SettingsPanel() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [section, setSection] = useState<Section>("general");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [signOutConfirm, setSignOutConfirm] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Account sign-in state (used when api_key is empty)
  type SignInMethod = "browser" | "apikey";
  const [signInMethod, setSignInMethod] = useState<SignInMethod>("browser");
  const [signInApiKey, setSignInApiKey] = useState("");
  const [signInWaiting, setSignInWaiting] = useState(false);
  const [signInLoading, setSignInLoading] = useState(false);
  const [signInError, setSignInError] = useState("");

  // Credential form state — kept separate so we don't auto-save passwords
  const [credUsername, setCredUsername] = useState("");
  const [credPassword, setCredPassword] = useState("");
  const [credSaving, setCredSaving] = useState(false);
  const [credStatus, setCredStatus] = useState<"idle" | "saved" | "error">("idle");
  const [credError, setCredError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const c = await invoke<AppConfig>("get_config");
        setConfig(c);
        setCredUsername(c.slsk_username || "");
      } catch {
        // Use defaults
      }
    })();
  }, []);

  // Listen for deep-link-url events emitted by the Rust handler.
  // This fires when the browser redirects to djtoolkit://configure?api_key=...
  useEffect(() => {
    const unlisten = listen<string>("deep-link-url", async (event) => {
      const url = event.payload;
      if (!url.startsWith("djtoolkit://configure")) return;
      const params = new URLSearchParams(url.split("?")[1] || "");
      const key = params.get("api_key") || "";
      if (!key.startsWith("djt_")) return;
      setSignInWaiting(false);
      setSignInLoading(true);
      setSignInError("");
      try {
        await invoke("sign_in_from_settings", {
          apiKey: key,
          supabaseUrl: params.get("supabase_url") || null,
          supabaseAnonKey: params.get("supabase_anon_key") || null,
          agentEmail: params.get("agent_email") || null,
          agentPassword: params.get("agent_password") || null,
        });
        const updated = await invoke<AppConfig>("get_config");
        setConfig(updated);
      } catch (e) {
        setSignInError(String(e));
      } finally {
        setSignInLoading(false);
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const handleBrowserSignIn = async () => {
    setSignInWaiting(true);
    setSignInError("");
    try {
      await openUrl(`${CLOUD_URL}/agent-connect`);
    } catch {
      setSignInWaiting(false);
      setSignInError("Could not open browser. Try pasting your API key.");
    }
  };

  const handleApiKeySignIn = async () => {
    if (!signInApiKey.trim().startsWith("djt_")) {
      setSignInError("API key must start with djt_");
      return;
    }
    setSignInLoading(true);
    setSignInError("");
    try {
      await invoke("sign_in_from_settings", {
        apiKey: signInApiKey.trim(),
        supabaseUrl: null,
        supabaseAnonKey: null,
        agentEmail: null,
        agentPassword: null,
      });
      const updated = await invoke<AppConfig>("get_config");
      setConfig(updated);
      setSignInApiKey("");
    } catch (e) {
      setSignInError(String(e));
    } finally {
      setSignInLoading(false);
    }
  };

  const saveConfig = useCallback(
    (updated: AppConfig) => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        setSaving(true);
        try {
          await invoke("save_config", { config: updated });
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        } catch {
          // save failed silently
        } finally {
          setSaving(false);
        }
      }, 600);
    },
    [],
  );

  const update = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    const updated = { ...config, [key]: value };
    setConfig(updated);
    saveConfig(updated);
  };

  const handleBrowse = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      update("downloads_dir", selected as string);
    }
  };

  const handleSignOut = async () => {
    if (!signOutConfirm) {
      setSignOutConfirm(true);
      setTimeout(() => setSignOutConfirm(false), 3000);
      return;
    }
    update("api_key", "");
    setSignOutConfirm(false);
  };

  const handleSaveCredentials = async () => {
    if (!credUsername.trim()) {
      setCredError("Username is required");
      setCredStatus("error");
      return;
    }
    if (!credPassword.trim()) {
      setCredError("Password is required");
      setCredStatus("error");
      return;
    }
    setCredSaving(true);
    setCredStatus("idle");
    setCredError("");
    try {
      await invoke("update_credentials", {
        slskUser: credUsername.trim(),
        slskPass: credPassword,
      });
      setCredStatus("saved");
      setCredPassword("");
      // Refresh config so slsk_username reflects the new value
      const updated = await invoke<AppConfig>("get_config");
      setConfig(updated);
      setCredUsername(updated.slsk_username || credUsername.trim());
      setTimeout(() => setCredStatus("idle"), 2000);
    } catch (e) {
      setCredError(String(e));
      setCredStatus("error");
    } finally {
      setCredSaving(false);
    }
  };

  return (
    <div className="settings-panel">
      <div className="settings-sidebar">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            className={`settings-nav-btn ${section === s.key ? "active" : ""}`}
            onClick={() => setSection(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="settings-content">
        <div className="settings-header">
          <h2>{SECTIONS.find((s) => s.key === section)?.label}</h2>
          {saving && <span className="settings-status">Saving...</span>}
          {saved && !saving && <span className="settings-status saved">Saved</span>}
        </div>

        {section === "general" && (
          <div className="settings-section">
            <div className="settings-field">
              <label>Downloads directory</label>
              <div className="settings-row">
                <input
                  type="text"
                  value={config.downloads_dir}
                  onChange={(e) => update("downloads_dir", e.currentTarget.value)}
                  placeholder="/path/to/downloads"
                  className="settings-input flex-grow"
                />
                <Button variant="secondary" size="small" onClick={handleBrowse}>
                  Browse
                </Button>
              </div>
            </div>

            <div className="settings-field">
              <Toggle
                label="Launch at startup"
                checked={config.launch_at_startup}
                onChange={(v) => update("launch_at_startup", v)}
              />
            </div>
          </div>
        )}

        {section === "credentials" && (
          <div className="settings-section">
            <p className="settings-hint">
              Credentials are stored securely in the system keychain.
            </p>
            <Input
              label="Soulseek username"
              type="text"
              value={credUsername}
              onChange={(e) => {
                setCredUsername(e.currentTarget.value);
                setCredStatus("idle");
              }}
              placeholder="Your Soulseek username"
            />
            <Input
              label="New Soulseek password"
              type="password"
              value={credPassword}
              onChange={(e) => {
                setCredPassword(e.currentTarget.value);
                setCredStatus("idle");
              }}
              placeholder="Enter password to update"
            />
            {credStatus === "error" && (
              <p className="form-error">{credError || "Failed to save credentials"}</p>
            )}
            {credStatus === "saved" && (
              <p className="form-success">Credentials saved</p>
            )}
            <Button onClick={handleSaveCredentials} loading={credSaving}>
              Save Credentials
            </Button>
          </div>
        )}

        {section === "agent" && (
          <div className="settings-section">
            <Input
              label="Poll interval (seconds)"
              type="number"
              value={config.poll_interval_sec}
              onChange={(e) => update("poll_interval_sec", Number(e.currentTarget.value))}
            />
            <Input
              label="Max concurrent jobs"
              type="number"
              value={config.max_concurrent_jobs}
              onChange={(e) => update("max_concurrent_jobs", Number(e.currentTarget.value))}
            />
          </div>
        )}

        {section === "account" && (
          <div className="settings-section">
            <div className="settings-field">
              <label className="settings-label">Status</label>
              <p className="settings-value">
                {config.api_key ? "Signed in" : "Not signed in"}
              </p>
            </div>

            {config.api_key ? (
              <Button variant="danger" onClick={handleSignOut}>
                {signOutConfirm ? "Confirm sign out?" : "Sign Out"}
              </Button>
            ) : (
              <>
                <div className="auth-toggle">
                  <button
                    className={`auth-toggle-btn ${signInMethod === "browser" ? "active" : ""}`}
                    onClick={() => { setSignInMethod("browser"); setSignInError(""); setSignInWaiting(false); }}
                  >
                    Browser
                  </button>
                  <button
                    className={`auth-toggle-btn ${signInMethod === "apikey" ? "active" : ""}`}
                    onClick={() => { setSignInMethod("apikey"); setSignInError(""); }}
                  >
                    API Key
                  </button>
                </div>

                {signInMethod === "browser" && (
                  <div className="signin-method">
                    <Button onClick={handleBrowserSignIn} disabled={signInWaiting || signInLoading}>
                      {signInWaiting ? "Waiting for browser…" : signInLoading ? "Signing in…" : "Open djtoolkit.net"}
                    </Button>
                    {signInWaiting && (
                      <p className="form-hint">Complete sign-in in your browser — this will update automatically.</p>
                    )}
                  </div>
                )}

                {signInMethod === "apikey" && (
                  <div className="signin-method">
                    <Input
                      label="API Key"
                      type="password"
                      placeholder="djt_…"
                      value={signInApiKey}
                      onChange={(e) => { setSignInApiKey(e.currentTarget.value); setSignInError(""); }}
                    />
                    <p className="form-hint">
                      Find your key at{" "}
                      <a href={`${CLOUD_URL}/settings`} target="_blank" rel="noreferrer">
                        djtoolkit.net/settings
                      </a>
                    </p>
                    <Button onClick={handleApiKeySignIn} disabled={signInLoading || !signInApiKey.trim()}>
                      {signInLoading ? "Signing in…" : "Sign In"}
                    </Button>
                  </div>
                )}

                {signInError && <p className="form-error">{signInError}</p>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
