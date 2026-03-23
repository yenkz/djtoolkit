"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { HARDWARE, FONTS, LED_COLORS } from "@/lib/design-system/tokens";
import LEDText from "@/components/ui/LEDText";

/**
 * Agent authentication page.
 *
 * The desktop Tauri app opens this URL with ?port=XXXXX.
 * If the user is signed in, sends the access token to the desktop app
 * via localhost callback. If not signed in, redirects to /login first.
 */
export default function AgentAuthPage() {
  const [status, setStatus] = useState<"checking" | "redirecting" | "done" | "error">("checking");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        // Not signed in — go to login, come back here after
        const currentUrl = window.location.href;
        window.location.href = `/login?redirect=${encodeURIComponent(new URL(currentUrl).pathname + new URL(currentUrl).search)}`;
        return;
      }

      setStatus("redirecting");
      const token = session.access_token;

      // Get the localhost port from query params (passed by the Tauri app)
      const params = new URLSearchParams(window.location.search);
      const port = params.get("port");

      if (port) {
        // Send token to the desktop app's localhost callback server
        try {
          window.location.href = `http://127.0.0.1:${port}/callback?token=${token}`;
          setStatus("done");
        } catch {
          setError("Failed to connect to the desktop app. Make sure it's running.");
          setStatus("error");
        }
      } else {
        // No port — try deep link as fallback
        window.location.href = `djtoolkit://auth/callback#access_token=${token}`;
        setTimeout(() => {
          setStatus("error");
          setError("Could not open the desktop app. Make sure djtoolkit is installed and running.");
        }, 3000);
      }
    })();
  }, []);

  return (
    <div
      style={{
        background: HARDWARE.body,
        color: HARDWARE.text,
        fontFamily: FONTS.sans,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 400, padding: 40 }}>
        <LEDText
          color="green"
          alwaysOn
          style={{
            fontFamily: FONTS.mono,
            fontWeight: 700,
            fontSize: 20,
            letterSpacing: -0.5,
            marginBottom: 24,
            display: "block",
          }}
        >
          DJToolKit
        </LEDText>

        {status === "checking" && (
          <>
            <Spinner />
            <StatusText>Checking authentication...</StatusText>
          </>
        )}

        {status === "redirecting" && (
          <>
            <Spinner />
            <StatusText>Connecting to desktop app...</StatusText>
          </>
        )}

        {status === "done" && (
          <>
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: LED_COLORS.green.on,
                boxShadow: LED_COLORS.green.glowHot,
                margin: "0 auto 16px",
              }}
            />
            <StatusText color={LED_COLORS.green.on}>
              Authenticated! You can close this tab.
            </StatusText>
          </>
        )}

        {status === "error" && (
          <>
            <StatusText color={LED_COLORS.orange.on}>{error}</StatusText>
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: 20,
                fontFamily: FONTS.mono,
                fontSize: 11,
                letterSpacing: 1,
                padding: "10px 24px",
                background: HARDWARE.raised,
                border: `1px solid ${HARDWARE.borderLight}`,
                borderRadius: 4,
                color: HARDWARE.text,
                cursor: "pointer",
              }}
            >
              Try Again
            </button>
          </>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function Spinner() {
  return (
    <div
      style={{
        width: 32,
        height: 32,
        border: `3px solid ${LED_COLORS.green.dim}`,
        borderTopColor: LED_COLORS.green.on,
        borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
        margin: "0 auto 16px",
      }}
    />
  );
}

function StatusText({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <p
      style={{
        fontFamily: FONTS.mono,
        fontSize: 12,
        color: color || HARDWARE.textDim,
        letterSpacing: 1,
        lineHeight: 1.6,
      }}
    >
      {children}
    </p>
  );
}
