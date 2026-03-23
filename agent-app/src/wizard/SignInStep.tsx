import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import Button from "../components/Button";
import Input from "../components/Input";

const CLOUD_URL = "https://app.djtoolkit.net";

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
  const [signedInEmail, setSignedInEmail] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleGoogleSignIn = async () => {
    setError("");
    setLoading(true);
    try {
      // Open OAuth window (Rust side handles navigation interception)
      await invoke("start_oauth");

      // Poll for the JWT result
      pollRef.current = setInterval(async () => {
        try {
          const jwt = await invoke<string | null>("check_oauth_result");
          if (jwt) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;

            // Register the agent with the cloud API
            const machineName = navigator.userAgent.includes("Mac")
              ? "My Mac"
              : "My PC";

            const res = await fetch(`${CLOUD_URL}/api/agents/register`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ machine_name: machineName }),
            });

            if (!res.ok) {
              const text = await res.text();
              throw new Error(`Registration failed (${res.status}): ${text}`);
            }

            const data = await res.json();
            onApiKeyChange(data.api_key);

            // Decode email from JWT for display
            try {
              const payload = JSON.parse(atob(jwt.split(".")[1]));
              setSignedInEmail(payload.email || "Authenticated");
            } catch {
              setSignedInEmail("Authenticated via Google");
            }

            // Close the OAuth window
            try {
              const { WebviewWindow } = await import(
                "@tauri-apps/api/webviewWindow"
              );
              const w = await WebviewWindow.getByLabel("oauth");
              if (w) await w.close();
            } catch {
              // window may already be closed
            }

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
      <p className="step-subtitle">Connect to your djtoolkit.net account</p>

      {signedInEmail ? (
        <div className="signed-in-banner">
          <span className="done-check">&#10003;</span>
          <span>{signedInEmail}</span>
        </div>
      ) : (
        <>
          <div className="form-fields">
            <Button onClick={handleGoogleSignIn} loading={loading}>
              Sign in with Google
            </Button>
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
            <p className="form-hint">
              Find your API key at{" "}
              <a
                href="https://app.djtoolkit.net/settings"
                target="_blank"
                rel="noreferrer"
              >
                djtoolkit.net/settings
              </a>
            </p>
          </div>
        </>
      )}

      {error && <p className="form-error">{error}</p>}

      <div className="wizard-actions">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        {!signedInEmail && (
          <Button onClick={handleApiKeyContinue}>Continue with API Key</Button>
        )}
      </div>
    </div>
  );
}
