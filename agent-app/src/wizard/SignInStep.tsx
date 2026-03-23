import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import Button from "../components/Button";
import Input from "../components/Input";

interface SignInStepProps {
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function SignInStep({
  apiKey,
  onApiKeyChange,
  onNext,
  onBack,
}: SignInStepProps) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleBrowserSignIn = async () => {
    setError("");
    setLoading(true);
    try {
      // Opens a branded login page in the system browser
      await invoke("start_browser_auth");

      // Poll for the result (deep-link callback handles registration)
      pollRef.current = setInterval(async () => {
        try {
          const apiKey = await invoke<string | null>("check_auth_result");
          if (apiKey) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            onApiKeyChange(apiKey);
            // Auto-start the daemon
            try { await invoke("start_agent"); } catch { /* may already be running */ }
            setLoading(false);
            onNext();
          }
        } catch (e) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setError(String(e));
          setLoading(false);
        }
      }, 1000);
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  const handleApiKeyContinue = () => {
    setError("");
    if (!apiKey.trim()) {
      setError("API key is required");
      return;
    }
    onNext();
  };

  return (
    <div className="wizard-step signin-step">
      <h2>Sign In</h2>
      <p className="step-subtitle">Sign in with your djtoolkit.net account</p>

      <div className="form-fields">
        <Button onClick={handleBrowserSignIn} loading={loading}>
          Sign in with Browser
        </Button>
        {loading && (
          <p className="form-hint">
            Complete sign-in in your browser, then return here.
          </p>
        )}
      </div>

      <div className="auth-divider">
        <span>or use an API key</span>
      </div>

      <div className="form-fields">
        <Input
          label="API Key"
          type="password"
          placeholder="djt_..."
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.currentTarget.value)}
        />
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="wizard-actions">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        {!loading && (
          <Button onClick={handleApiKeyContinue}>Continue with API Key</Button>
        )}
      </div>
    </div>
  );
}
