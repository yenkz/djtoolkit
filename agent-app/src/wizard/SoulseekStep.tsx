import { useState } from "react";
import Button from "../components/Button";
import Input from "../components/Input";

interface SoulseekStepProps {
  username: string;
  password: string;
  onUsernameChange: (val: string) => void;
  onPasswordChange: (val: string) => void;
  onNext: () => void;
  onBack: () => void;
  error?: string;
  loading?: boolean;
}

export default function SoulseekStep({
  username,
  password,
  onUsernameChange,
  onPasswordChange,
  onNext,
  onBack,
  error,
  loading = false,
}: SoulseekStepProps) {
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({});

  const handleContinue = () => {
    const newErrors: { username?: string; password?: string } = {};
    if (!username.trim()) newErrors.username = "Username is required";
    if (!password.trim()) newErrors.password = "Password is required";

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setErrors({});
    onNext();
  };

  return (
    <div className="wizard-step soulseek-step">
      <h2>Soulseek Credentials</h2>
      <p className="step-subtitle">Enter your Soulseek account details</p>
      <p className="step-description">
        djtoolkit uses Soulseek to search and download music. You need a Soulseek account.
      </p>

      <div className="form-fields">
        <Input
          label="Username"
          type="text"
          placeholder="Your Soulseek username"
          value={username}
          onChange={(e) => {
            onUsernameChange(e.currentTarget.value);
            if (errors.username) setErrors((prev) => ({ ...prev, username: undefined }));
          }}
          error={errors.username}
        />
        <Input
          label="Password"
          type="password"
          placeholder="Your Soulseek password"
          value={password}
          onChange={(e) => {
            onPasswordChange(e.currentTarget.value);
            if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
          }}
          error={errors.password}
        />
      </div>

      <p className="form-hint">
        Don't have an account?{" "}
        <a href="https://www.slsknet.org/news/node/1" target="_blank" rel="noreferrer">
          Create one at slsknet.org
        </a>
      </p>

      {error && <p className="form-error">{error}</p>}

      <div className="wizard-actions">
        <Button variant="secondary" onClick={onBack} disabled={loading}>
          Back
        </Button>
        <Button onClick={handleContinue} loading={loading}>
          Continue
        </Button>
      </div>
    </div>
  );
}
