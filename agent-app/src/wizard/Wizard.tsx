import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { WizardData } from "../types";
import WelcomeStep from "./WelcomeStep";
import SignInStep from "./SignInStep";
import SoulseekStep from "./SoulseekStep";
import DoneStep from "./DoneStep";

const STEP_LABELS = ["Welcome", "Sign In", "Soulseek", "Done"];

export default function Wizard() {
  const [step, setStep] = useState(0);
  const [data, setData] = useState<WizardData>({
    apiKey: "",
    slskUsername: "",
    slskPassword: "",
    launchAtStartup: true,
  });

  const goNext = () => setStep((s) => Math.min(s + 1, STEP_LABELS.length - 1));
  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  const [configError, setConfigError] = useState("");

  const handleSoulseekDone = async () => {
    try {
      setConfigError("");
      await invoke("configure_agent", {
        apiKey: data.apiKey,
        slskUser: data.slskUsername,
        slskPass: data.slskPassword,
      });
      goNext();
    } catch (err) {
      setConfigError(String(err));
    }
  };

  return (
    <div className="wizard-container">
      <div className="wizard-progress">
        {STEP_LABELS.map((label, i) => (
          <div
            key={label}
            className={`wizard-dot ${i === step ? "active" : ""} ${i < step ? "completed" : ""}`}
          >
            <div className="dot-circle">
              {i < step ? (
                <span className="dot-check">&#10003;</span>
              ) : (
                <span className="dot-number">{i + 1}</span>
              )}
            </div>
            <span className="dot-label">{label}</span>
          </div>
        ))}
      </div>

      <div className="wizard-content">
        <div className="wizard-slide" key={step}>
          {step === 0 && <WelcomeStep onNext={goNext} />}
          {step === 1 && (
            <SignInStep
              apiKey={data.apiKey}
              onApiKeyChange={(v) => setData((d) => ({ ...d, apiKey: v }))}
              onNext={goNext}
              onBack={goBack}
            />
          )}
          {step === 2 && (
            <SoulseekStep
              username={data.slskUsername}
              password={data.slskPassword}
              onUsernameChange={(v) => setData((d) => ({ ...d, slskUsername: v }))}
              onPasswordChange={(v) => setData((d) => ({ ...d, slskPassword: v }))}
              onNext={handleSoulseekDone}
              onBack={goBack}
              error={configError}
            />
          )}
          {step === 3 && (
            <DoneStep
              launchAtStartup={data.launchAtStartup}
              onLaunchAtStartupChange={(v) => setData((d) => ({ ...d, launchAtStartup: v }))}
            />
          )}
        </div>
      </div>
    </div>
  );
}
