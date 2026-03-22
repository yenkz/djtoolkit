import { useState } from "react";
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
  const [useApiKey, setUseApiKey] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleContinue = async () => {
    setError("");

    if (useApiKey) {
      if (!apiKey.trim()) {
        setError("API key is required");
        return;
      }
      onNext();
    } else {
      if (!email.trim() || !password.trim()) {
        setError("Email and password are required");
        return;
      }
      // OAuth flow placeholder -- for now just show a message
      setLoading(true);
      setTimeout(() => {
        setLoading(false);
        setError("Email/password sign-in is not yet available. Please use an API key.");
      }, 1000);
    }
  };

  return (
    <div className="wizard-step signin-step">
      <h2>Sign In</h2>
      <p className="step-subtitle">Connect to your djtoolkit.net account</p>

      <div className="auth-toggle">
        <button
          type="button"
          className={`auth-toggle-btn ${!useApiKey ? "active" : ""}`}
          onClick={() => setUseApiKey(false)}
        >
          Email & Password
        </button>
        <button
          type="button"
          className={`auth-toggle-btn ${useApiKey ? "active" : ""}`}
          onClick={() => setUseApiKey(true)}
        >
          API Key
        </button>
      </div>

      {useApiKey ? (
        <div className="form-fields">
          <Input
            label="API Key"
            type="password"
            placeholder="dtk_..."
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.currentTarget.value)}
          />
          <p className="form-hint">
            Find your API key at{" "}
            <a href="https://app.djtoolkit.net/settings" target="_blank" rel="noreferrer">
              djtoolkit.net/settings
            </a>
          </p>
        </div>
      ) : (
        <div className="form-fields">
          <Input
            label="Email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
          />
          <Input
            label="Password"
            type="password"
            placeholder="Your password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
        </div>
      )}

      {error && <p className="form-error">{error}</p>}

      <div className="wizard-actions">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button onClick={handleContinue} loading={loading}>
          Continue
        </Button>
      </div>
    </div>
  );
}
