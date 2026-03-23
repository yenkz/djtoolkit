import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppConfig } from "../types";
import Button from "../components/Button";
import Input from "../components/Input";
import Toggle from "../components/Toggle";


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
  slsk_username: "",
  slsk_password: "",
  acoustid_api_key: "",
  poll_interval_secs: 30,
  max_concurrent_jobs: 2,
  api_key: "",
};

export default function SettingsPanel() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [section, setSection] = useState<Section>("general");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [signOutConfirm, setSignOutConfirm] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const c = await invoke<AppConfig>("get_config");
        setConfig(c);
      } catch {
        // Use defaults
      }
    })();
  }, []);

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

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const handleBrowserSignIn = async () => {
    setOauthError("");
    setOauthLoading(true);
    try {
      await invoke("start_browser_auth");
      pollRef.current = setInterval(async () => {
        try {
          const apiKey = await invoke<string | null>("check_auth_result");
          if (apiKey) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            update("api_key", apiKey);
            setOauthLoading(false);
          }
        } catch (e) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setOauthError(String(e));
          setOauthLoading(false);
        }
      }, 1000);
    } catch (e) {
      setOauthError(String(e));
      setOauthLoading(false);
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
            <Input
              label="Soulseek username"
              type="text"
              value={config.slsk_username}
              onChange={(e) => update("slsk_username", e.currentTarget.value)}
              placeholder="Username"
            />
            <Input
              label="Soulseek password"
              type="password"
              value={config.slsk_password}
              onChange={(e) => update("slsk_password", e.currentTarget.value)}
              placeholder="Password"
            />
            <Input
              label="AcoustID API key (optional)"
              type="text"
              value={config.acoustid_api_key}
              onChange={(e) => update("acoustid_api_key", e.currentTarget.value)}
              placeholder="API key"
            />
          </div>
        )}

        {section === "agent" && (
          <div className="settings-section">
            <Input
              label="Poll interval (seconds)"
              type="number"
              value={config.poll_interval_secs}
              onChange={(e) => update("poll_interval_secs", Number(e.currentTarget.value))}
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
              <label>Status</label>
              <p className="settings-value">
                {config.api_key ? "Signed in" : "Not signed in"}
              </p>
            </div>

            {!config.api_key && (
              <>
                <Button onClick={handleBrowserSignIn} loading={oauthLoading}>
                  Sign in with Browser
                </Button>
                {oauthLoading && (
                  <p className="form-hint">Complete sign-in in your browser...</p>
                )}

                <div className="auth-divider">
                  <span>or enter API key manually</span>
                </div>

                <Input
                  label="API Key"
                  type="password"
                  placeholder="djt_..."
                  value={config.api_key}
                  onChange={(e) => update("api_key", e.currentTarget.value)}
                />

                {oauthError && <p className="form-error">{oauthError}</p>}
              </>
            )}

            {config.api_key && (
              <Button variant="danger" onClick={handleSignOut}>
                {signOutConfirm ? "Confirm sign out?" : "Sign Out"}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
