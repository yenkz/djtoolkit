"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { HARDWARE, FONTS, LED_COLORS } from "@/lib/design-system/tokens";
import LEDText from "@/components/ui/LEDText";

/**
 * Agent authentication page.
 *
 * The desktop Tauri app opens this URL in the system browser.
 * If the user is already signed in, it immediately redirects to
 * `djtoolkit://auth/callback#access_token=XXX`.
 * If not signed in, it redirects to /login with a return URL.
 */
export default function AgentAuthPage() {
  const [status, setStatus] = useState<"checking" | "redirecting" | "error">(
    "checking"
  );
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        // Not signed in — redirect to login, then come back here
        window.location.href = `/login?redirect=${encodeURIComponent("/auth/agent")}`;
        return;
      }

      // User is signed in — redirect to desktop app with the token
      setStatus("redirecting");
      const token = session.access_token;

      // Small delay so the user sees the "Redirecting" message
      setTimeout(() => {
        window.location.href = `djtoolkit://auth/callback#access_token=${token}`;
      }, 500);

      // After redirect, show a fallback message in case the deep link doesn't work
      setTimeout(() => {
        setStatus("error");
        setError(
          "If the djtoolkit app didn't open, make sure it's running and try again."
        );
      }, 3000);
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
            <p
              style={{
                fontFamily: FONTS.mono,
                fontSize: 12,
                color: HARDWARE.textDim,
                letterSpacing: 1,
              }}
            >
              Checking authentication...
            </p>
          </>
        )}

        {status === "redirecting" && (
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
            <p
              style={{
                fontFamily: FONTS.mono,
                fontSize: 12,
                color: LED_COLORS.green.on,
                textShadow: LED_COLORS.green.glow,
                letterSpacing: 1,
              }}
            >
              Authenticated! Redirecting to app...
            </p>
          </>
        )}

        {status === "error" && (
          <>
            <p
              style={{
                fontFamily: FONTS.mono,
                fontSize: 12,
                color: LED_COLORS.orange.on,
                letterSpacing: 0.5,
                lineHeight: 1.6,
              }}
            >
              {error}
            </p>
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
