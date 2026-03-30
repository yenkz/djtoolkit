import { useState, useEffect, useRef, useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { listen } from "@tauri-apps/api/event";
import Button from "../components/Button";
import Input from "../components/Input";

const CLOUD_URL = "https://www.djtoolkit.net";

interface Credentials {
  apiKey: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  agentEmail: string;
  agentPassword: string;
}

interface SignInStepProps {
  onCredentials: (creds: Credentials) => void;
  onNext: () => void;
  onBack: () => void;
}

type AuthMethod = "browser" | "apikey";

export default function SignInStep({ onCredentials, onNext, onBack }: SignInStepProps) {
  const [method, setMethod] = useState<AuthMethod>("browser");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);
  const unlistenFallbackRef = useRef<(() => void) | null>(null);

  // Parse a djtoolkit:// deep link URL and advance the wizard.
  const handleDeepLink = useCallback((url: string) => {
    if (!url.startsWith("djtoolkit://configure")) return;
    const params = new URLSearchParams(url.split("?")[1] || "");
    const key = params.get("api_key") || "";
    if (!key.startsWith("djt_")) return;
    onCredentials({
      apiKey: key,
      supabaseUrl: params.get("supabase_url") || "",
      supabaseAnonKey: params.get("supabase_anon_key") || "",
      agentEmail: params.get("agent_email") || "",
      agentPassword: params.get("agent_password") || "",
    });
    setWaiting(false);
    onNext();
  }, [onCredentials, onNext]);

  // Subscribe to deep links via two channels:
  // 1. The deep-link plugin API (macOS — the OS routes to the running app)
  // 2. The generic "deep-link-url" Tauri event (Windows — the single-instance
  //    plugin catches the second process and emits this event)
  useEffect(() => {
    onOpenUrl((urls) => {
      handleDeepLink(urls[0] || "");
    }).then((unlisten) => {
      unlistenRef.current = unlisten;
    });

    // Fallback for Windows single-instance forwarding
    listen<string>("deep-link-url", (event) => {
      handleDeepLink(event.payload);
    }).then((unlisten) => {
      unlistenFallbackRef.current = unlisten;
    });

    return () => {
      unlistenRef.current?.();
      unlistenFallbackRef.current?.();
    };
  }, [handleDeepLink]);

  const clearError = () => setError("");

  const switchMethod = (m: AuthMethod) => {
    setMethod(m);
    clearError();
    setWaiting(false);
  };

  // --- Browser auth ---
  const handleBrowserSignIn = async () => {
    setWaiting(true);
    setError("");
    try {
      await openUrl(`${CLOUD_URL}/agent-connect`);
    } catch {
      setWaiting(false);
      setError("Could not open browser. Try another sign-in method.");
    }
  };

  // --- API key ---
  const handleApiKeyNext = () => {
    if (!apiKey.trim()) {
      setError("API key is required");
      return;
    }
    if (!apiKey.trim().startsWith("djt_")) {
      setError("API key must start with djt_");
      return;
    }
    onCredentials({
      apiKey: apiKey.trim(),
      supabaseUrl: "",
      supabaseAnonKey: "",
      agentEmail: "",
      agentPassword: "",
    });
    onNext();
  };

  return (
    <div className="wizard-step signin-step">
      <h2>Sign In</h2>
      <p className="step-subtitle">Connect to your djtoolkit.net account</p>

      <div className="auth-toggle">
        <button
          className={`auth-toggle-btn ${method === "browser" ? "active" : ""}`}
          onClick={() => switchMethod("browser")}
        >
          Browser
        </button>
        <button
          className={`auth-toggle-btn ${method === "apikey" ? "active" : ""}`}
          onClick={() => switchMethod("apikey")}
        >
          API Key
        </button>
      </div>

      {method === "browser" && (
        <div className="signin-method">
          <p className="step-description">
            Opens djtoolkit.net in your browser — sign in there and this wizard
            advances automatically.
          </p>
          <Button onClick={handleBrowserSignIn} disabled={waiting}>
            {waiting ? "Waiting for browser…" : "Open djtoolkit.net"}
          </Button>
          {waiting && (
            <p className="form-hint">
              Complete sign-in in your browser — this window will advance
              automatically.
            </p>
          )}
        </div>
      )}

      {method === "apikey" && (
        <div className="signin-method">
          <div className="form-fields">
            <Input
              label="API Key"
              type="password"
              placeholder="djt_…"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.currentTarget.value);
                clearError();
              }}
            />
            <p className="form-hint">
              Find your key at{" "}
              <a
                href={`${CLOUD_URL}/settings`}
                target="_blank"
                rel="noreferrer"
              >
                djtoolkit.net/settings
              </a>
            </p>
          </div>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}

      <div className="wizard-actions">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        {method === "apikey" && (
          <Button onClick={handleApiKeyNext} disabled={!apiKey.trim()}>
            Continue
          </Button>
        )}
      </div>
    </div>
  );
}
