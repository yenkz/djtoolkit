import { useState, useEffect, useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
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

  // Subscribe to deep links for the browser-based sign-in flow.
  // When the web app redirects to djtoolkit://configure?api_key=... this fires,
  // extracts the credentials, and advances the wizard automatically.
  useEffect(() => {
    onOpenUrl((urls) => {
      const url = urls[0] || "";
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
    }).then((unlisten) => {
      unlistenRef.current = unlisten;
    });
    return () => {
      unlistenRef.current?.();
    };
  }, [onCredentials, onNext]);

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
