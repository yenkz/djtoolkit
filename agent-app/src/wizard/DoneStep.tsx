import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Button from "../components/Button";
import Toggle from "../components/Toggle";

interface DoneStepProps {
  launchAtStartup: boolean;
  onLaunchAtStartupChange: (val: boolean) => void;
}

export default function DoneStep({
  launchAtStartup,
  onLaunchAtStartupChange,
}: DoneStepProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const handleStart = async () => {
    setStarting(true);
    setError("");
    try {
      await invoke("start_agent");
      await getCurrentWindow().close();
    } catch (e) {
      setError(String(e));
      setStarting(false);
    }
  };

  const handleClose = async () => {
    await getCurrentWindow().close();
  };

  return (
    <div className="wizard-step done-step">
      <h2>You're all set!</h2>

      <div className="done-checklist">
        <div className="done-item">
          <span className="done-check">&#10003;</span>
          <span>Account connected</span>
        </div>
        <div className="done-item">
          <span className="done-check">&#10003;</span>
          <span>Soulseek configured</span>
        </div>
      </div>

      <div className="done-options">
        <Toggle
          label="Launch at startup"
          checked={launchAtStartup}
          onChange={onLaunchAtStartupChange}
        />
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="wizard-actions">
        <Button variant="secondary" onClick={handleClose}>
          Close
        </Button>
        <Button onClick={handleStart} loading={starting}>
          Start Agent
        </Button>
      </div>
    </div>
  );
}
