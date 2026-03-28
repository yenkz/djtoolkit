import { useState, useEffect, useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import Button from "../components/Button";
import Input from "../components/Input";

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

export default function SignInStep({ onCredentials, onNext, onBack }: SignInStepProps) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);

  // Subscribe to deep links for the browser-based sign-in flow.
  // When the web app redirects to djtoolkit://configure?api_key=...
  // this fires, extracts the credentials, and advances the wizard.
  useEffect(() => {
    onOpenUrl((urls) => {
      const url = urls[0] || "";
      if (!url.startsWith("djtoolkit://configure")) return;
      const queryString = url.split("?")[1] || "";
      const params = new URLSearchParams(queryString);
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

  const handleBrowserSignIn = async () => {
    setWaiting(true);
    setError("");
    try {
      await openUrl("https://app.djtoolkit.net/agent-connect");
    } catch {
      setWaiting(false);
      setError("Could not open browser. Try pasting your API key manually.");
    }
  };

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

      <div className="signin-browser">
        <Button onClick={handleBrowserSignIn} loading={waiting}>
          {waiting ? "Waiting for browser…" : "Sign in with djtoolkit.net"}
        </Button>
        {waiting && (
          <p className="form-hint">
            Complete sign‑in in your browser — this window will advance automatically.
          </p>
        )}
      </div>

      <div className="signin-divider">
        <span>or paste your API key</span>
      </div>

      <div className="form-fields">
        <Input
          label="API Key"
          type="password"
          placeholder="djt_…"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.currentTarget.value);
            setError("");
          }}
        />
        <p className="form-hint">
          Find your key at{" "}
          <a
            href="https://app.djtoolkit.net/settings"
            target="_blank"
            rel="noreferrer"
          >
            djtoolkit.net/settings
          </a>
        </p>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="wizard-actions">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="secondary"
          onClick={handleApiKeyNext}
          disabled={waiting || !apiKey.trim()}
        >
          Continue with API key
        </Button>
      </div>
    </div>
  );
}
