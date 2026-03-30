import { useState, useEffect } from "react";
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
  const [agentRunning, setAgentRunning] = useState(false);

  useEffect(() => {
    invoke<string>("get_daemon_status").then((status) => {
      const s = status.toLowerCase();
      setAgentRunning(s === "running" || s === "starting");
    });
  }, []);

  const handleStartAndClose = async () => {
    setStarting(true);
    setError("");
    try {
      await invoke("start_agent");
    } catch (e) {
      const msg = String(e);
      // "already running" is not an error — just close
      if (!msg.includes("already running")) {
        setError(msg);
        setStarting(false);
        return;
      }
    }
    await getCurrentWindow().close();
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

      <div className="done-menubar-info">
        <span className="done-menubar-icon">&#9432;</span>
        <span>
          DJ Toolkit lives in your menu bar. After closing this window, look
          for the icon in the top-right of your screen.
        </span>
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
        {agentRunning ? (
          <Button onClick={handleClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={handleClose}>
              Close without starting
            </Button>
            <Button onClick={handleStartAndClose} loading={starting}>
              Start Agent &amp; Close
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
