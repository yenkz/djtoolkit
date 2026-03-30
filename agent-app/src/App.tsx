import { useEffect, useState } from "react";
import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Wizard from "./wizard/Wizard";
import LogViewer from "./logs/LogViewer";
import SettingsPanel from "./settings/SettingsPanel";
import { checkForUpdates } from "./updater";
import "./App.css";

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Only redirect to wizard from the main window (root path)
    // Logs and settings windows open at their own paths
    if (location.pathname !== "/") {
      setReady(true);
      return;
    }

    (async () => {
      try {
        const done = await invoke<boolean>("is_onboarding_complete");
        if (!done) {
          navigate("/wizard", { replace: true });
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
        } else {
          checkForUpdates();
        }
      } catch {
        navigate("/wizard", { replace: true });
      }
      setReady(true);
    })();
  }, [navigate, location.pathname]);

  if (!ready) return null;

  return (
    <Routes>
      <Route path="/wizard" element={<Wizard />} />
      <Route path="/logs" element={<LogViewer />} />
      <Route path="/settings" element={<SettingsPanel />} />
      <Route path="/" element={<Wizard />} />
    </Routes>
  );
}

export default App;
