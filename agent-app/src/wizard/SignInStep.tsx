import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Button from "../components/Button";
import Input from "../components/Input";

interface SignInResult {
  api_key: string;
  email: string;
}

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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [signedInEmail, setSignedInEmail] = useState("");

  const handleSignIn = async () => {
    setError("");
    if (!email.trim() || !password.trim()) {
      setError("Email and password are required");
      return;
    }
    setLoading(true);
    try {
      const result = await invoke<SignInResult>("sign_in", {
        email: email.trim(),
        password,
      });
      onApiKeyChange(result.api_key);
      setSignedInEmail(result.email);
      setLoading(false);
      onNext();
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

      {signedInEmail ? (
        <div className="signed-in-banner">
          <span className="done-check">&#10003;</span>
          <span>Signed in as {signedInEmail}</span>
        </div>
      ) : (
        <>
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

          <div className="wizard-actions" style={{ marginBottom: 16 }}>
            <div />
            <Button onClick={handleSignIn} loading={loading}>
              Sign In
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
