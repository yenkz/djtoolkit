import { useEffect } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import Wizard from "./wizard/Wizard";
import LogViewer from "./logs/LogViewer";
import SettingsPanel from "./settings/SettingsPanel";
import "./App.css";

function App() {
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      try {
        const configured = await invoke<boolean>("has_config");
        if (!configured) {
          navigate("/wizard", { replace: true });
        }
      } catch {
        // If the command fails, default to wizard
        navigate("/wizard", { replace: true });
      }
    })();
  }, [navigate]);

  return (
    <Routes>
      <Route path="/wizard" element={<Wizard />} />
      <Route path="/logs" element={<LogViewer />} />
      <Route path="/settings" element={<SettingsPanel />} />
      <Route path="*" element={<Wizard />} />
    </Routes>
  );
}

export default App;
