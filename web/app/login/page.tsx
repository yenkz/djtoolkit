"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { LED_COLORS, HARDWARE, FONTS, STEEL } from "@/lib/design-system/tokens";
import type { LEDColor } from "@/lib/design-system/tokens";
import Logo from "@/components/ui/Logo";
import LEDText from "@/components/ui/LEDText";
import JogWheel from "@/components/ui/JogWheel";
import VUMeter from "@/components/ui/VUMeter";

/* ═══ MODE TOGGLE (Login/Signup channel selector) ═══ */
function ModeToggle({
  mode,
  onSwitch,
}: {
  mode: "login" | "signup";
  onSwitch: (m: "login" | "signup") => void;
}) {
  const modes: { key: "login" | "signup"; label: string; color: LEDColor }[] = [
    { key: "login", label: "LOG IN", color: "green" },
    { key: "signup", label: "SIGN UP", color: "blue" },
  ];
  return (
    <div style={{ display: "flex", gap: 0, marginBottom: 32 }}>
      {modes.map((m) => {
        const active = mode === m.key;
        const c = LED_COLORS[m.color];
        return (
          <button
            key={m.key}
            type="button"
            onClick={() => onSwitch(m.key)}
            style={{
              flex: 1,
              fontFamily: FONTS.mono,
              fontSize: "clamp(9px, 1.3vw, 10px)",
              fontWeight: 700,
              letterSpacing: 2,
              textTransform: "uppercase",
              padding: "12px 0",
              cursor: "pointer",
              background: active ? `${c.on}12` : "transparent",
              color: active ? c.on : c.dim,
              border: `1.5px solid ${active ? c.on + "44" : HARDWARE.borderLight}`,
              borderRight: m.key === "login" ? "none" : undefined,
              textShadow: active ? c.glow : "none",
              boxShadow: active
                ? `0 0 12px ${c.on}11, inset 0 0 8px ${c.on}08`
                : "none",
              transition: "all 0.25s",
              borderRadius:
                m.key === "login" ? "3px 0 0 3px" : "0 3px 3px 0",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: active ? c.on : c.dim,
                  boxShadow: active ? c.glow : "none",
                  transition: "all 0.3s",
                }}
              />
              {m.label}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ═══ LED INPUT (auth-specific with color prop) ═══ */
function AuthLEDInput({
  label,
  color = "green",
  ...props
}: {
  label: string;
  color?: LEDColor;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const c = LED_COLORS[color];
  const lit = focused || hovered;

  return (
    <div
      style={{ marginBottom: 20 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <label
        style={{
          fontFamily: FONTS.mono,
          fontSize: "clamp(8px, 1.2vw, 9px)",
          fontWeight: 700,
          letterSpacing: 2,
          textTransform: "uppercase",
          color: lit ? c.on : c.dim,
          textShadow: lit ? c.glow : "none",
          transition: "all 0.3s",
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: lit ? c.on : c.dim,
            boxShadow: lit ? c.glow : "none",
            transition: "all 0.3s",
          }}
        />
        {label}
      </label>
      <input
        {...props}
        onFocus={(e) => {
          setFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          props.onBlur?.(e);
        }}
        style={{
          width: "100%",
          fontFamily: FONTS.mono,
          fontSize: "clamp(12px, 1.8vw, 14px)",
          color: HARDWARE.text,
          background: focused ? HARDWARE.groove : HARDWARE.raised,
          border: `1.5px solid ${focused ? c.on + "55" : hovered ? c.dim + "44" : HARDWARE.borderLight}`,
          borderRadius: 3,
          padding: "12px 14px",
          outline: "none",
          boxShadow: focused
            ? `0 0 12px ${c.on}15, inset 0 0 8px ${c.on}08`
            : `inset 0 1px 0 rgba(255,255,255,0.03)`,
          transition: "all 0.25s",
          letterSpacing: 0.5,
          ...props.style,
        }}
      />
    </div>
  );
}

/* ═══ CDJ PLAY BUTTON (submit variant) ═══ */
function SubmitButton({
  label,
  loading = false,
  color = "green",
}: {
  label: string;
  loading?: boolean;
  color?: LEDColor;
}) {
  const [h, setH] = useState(false);
  const [p, setP] = useState(false);
  const c = LED_COLORS[color];
  const rc = p ? c.on : h ? c.mid : c.dim;
  const rg = p ? c.glowHot : h ? c.glow : "none";

  return (
    <button
      type="submit"
      disabled={loading}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => {
        setH(false);
        setP(false);
      }}
      onMouseDown={() => setP(true)}
      onMouseUp={() => setP(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        background: "none",
        border: "none",
        cursor: loading ? "wait" : "pointer",
        padding: 0,
        width: "100%",
      }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          minWidth: 52,
          borderRadius: "50%",
          position: "relative",
          background: `radial-gradient(circle, ${HARDWARE.raised} 0%, ${HARDWARE.groove} 100%)`,
          boxShadow: `inset 0 2px 4px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4), ${rg}`,
          transform: p ? "scale(0.95)" : "scale(1)",
          transition: "all 0.2s",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 3,
            borderRadius: "50%",
            border: `${p ? 4 : h ? 3 : 2}px solid ${rc}`,
            boxShadow: `inset 0 0 ${p ? 10 : h ? 6 : 2}px ${rc}44`,
            transition: "all 0.2s",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 10,
            borderRadius: "50%",
            background: `radial-gradient(circle at 40% 35%, rgba(255,255,255,0.1) 0%, transparent 50%), ${STEEL.conic}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {loading ? (
            <div
              style={{
                width: 14,
                height: 14,
                border: `2px solid ${rc}`,
                borderTopColor: "transparent",
                borderRadius: "50%",
                animation: "auth-spin 0.6s linear infinite",
              }}
            />
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M6 3l12 9-12 9V3z"
                fill={p ? c.on : h ? "#ddd" : "#999"}
                style={{
                  filter: p ? `drop-shadow(0 0 4px ${c.on})` : "none",
                }}
              />
            </svg>
          )}
        </div>
      </div>
      <span
        style={{
          fontFamily: FONTS.mono,
          fontSize: "clamp(10px, 1.5vw, 12px)",
          fontWeight: 700,
          letterSpacing: 2,
          textTransform: "uppercase",
          color: h || p ? c.on : HARDWARE.textDim,
          textShadow: h || p ? c.glow : "none",
          transition: "all 0.25s",
        }}
      >
        {label}
      </span>
    </button>
  );
}

/* ═══ ANIMATED VU STRIP (decorative, two channels) ═══ */
function AnimatedVUStrip() {
  const [levels, setLevels] = useState([0.6, 0.4]);
  useEffect(() => {
    const iv = setInterval(() => {
      setLevels([0.3 + Math.random() * 0.6, 0.2 + Math.random() * 0.5]);
    }, 800);
    return () => clearInterval(iv);
  }, []);

  return (
    <div style={{ display: "flex", gap: 4 }}>
      {levels.map((l, ch) => (
        <VUMeter key={ch} level={l} segments={10} height={120} />
      ))}
    </div>
  );
}

/* ═══ WAVEFORM FOOTER DECORATION ═══ */
function generateBars() {
  return Array.from({ length: 60 }, (_, i) => ({
    h: Math.max(
      2,
      Math.sin((i / 60) * Math.PI) *
        (0.15 + Math.random() * 0.85) *
        24,
    ),
    d: i * 15,
  }));
}

function WaveformDecor() {
  const [inView, setInView] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount animation trigger
  useEffect(() => { setInView(true); }, []);
  const [bars] = useState(generateBars);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 1,
        height: 24,
        opacity: 0.3,
      }}
    >
      {bars.map((b, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            background: LED_COLORS.green.dim,
            height: inView ? b.h : 0,
            transition: `height 0.6s ease ${b.d}ms`,
          }}
        />
      ))}
    </div>
  );
}

/* ═══ GOOGLE ICON SVG ═══ */
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

/* ═══ MAIN AUTH PAGE ═══ */
export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect");
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isLogin = mode === "login";
  const accentColor: LEDColor = isLogin ? "green" : "blue";

  /* ── Auth handlers (preserved from original) ── */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!isLogin && password !== confirmPw) {
      toast.error("Passwords do not match");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: name } },
        });
        if (error) throw error;
        toast.success("Check your email to confirm your account.");
        setLoading(false);
        return;
      }
      router.push(redirectTo || "/catalog");
      router.refresh();
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Authentication failed",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleLogin() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  if (!mounted) {
    return (
      <div
        style={{ background: HARDWARE.body, minHeight: "100vh" }}
      />
    );
  }

  return (
    <div
      style={{
        background: HARDWARE.body,
        color: HARDWARE.text,
        fontFamily: FONTS.sans,
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        overflowX: "hidden",
      }}
    >
      <style>{`
        ::selection { background: ${LED_COLORS[accentColor].on}33; }
        input::placeholder { color: ${HARDWARE.textDim}; font-family: ${FONTS.mono}; }
        @keyframes auth-spin { to { transform: rotate(360deg); } }
        .auth-layout {
          display: grid;
          grid-template-columns: 1fr 1fr;
          min-height: 100vh;
        }
        @media (max-width: 860px) {
          .auth-layout { grid-template-columns: 1fr; }
          .auth-side-panel { display: none !important; }
        }
      `}</style>

      <div className="auth-layout">
        {/* ═══ LEFT: DECORATIVE PANEL ═══ */}
        <div
          className="auth-side-panel"
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            padding: "60px 48px",
            position: "relative",
            overflow: "hidden",
            background: `linear-gradient(135deg, ${HARDWARE.body} 0%, ${HARDWARE.surface} 100%)`,
            borderRight: `1px solid ${HARDWARE.borderLight}`,
          }}
        >
          {/* Ambient glow */}
          <div
            style={{
              position: "absolute",
              top: "30%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: 300,
              height: 300,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${LED_COLORS[accentColor].on}08 0%, transparent 70%)`,
              filter: "blur(60px)",
              transition: "background 1s",
            }}
          />

          {/* Jog wheel */}
          <div style={{ width: 180, maxWidth: 180 }}>
            <JogWheel />
          </div>

          {/* Tagline */}
          <div
            style={{
              marginTop: 40,
              textAlign: "center",
              position: "relative",
              zIndex: 1,
            }}
          >
            <h2
              style={{
                fontSize: "clamp(24px, 3vw, 36px)",
                fontWeight: 900,
                letterSpacing: -1.5,
                lineHeight: 0.95,
                marginBottom: 12,
              }}
            >
              SYNC.
              <br />
              ORGANIZE.
              <br />
              <LEDText
                color={accentColor}
                alwaysOn
                style={{ fontSize: "inherit", fontWeight: "inherit" }}
              >
                PLAY.
              </LEDText>
            </h2>
            <p
              style={{
                fontFamily: FONTS.mono,
                fontSize: 10,
                color: HARDWARE.textDim,
                letterSpacing: 1,
                lineHeight: 1.8,
                maxWidth: 260,
              }}
            >
              Your entire music library,
              <br />
              organized for the decks.
            </p>
          </div>

          {/* VU meters decorative */}
          <div
            style={{
              position: "absolute",
              bottom: 48,
              left: 48,
              display: "flex",
              gap: 16,
              alignItems: "flex-end",
            }}
          >
            <AnimatedVUStrip />
          </div>

          {/* Waveform at bottom */}
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              padding: "0 24px",
            }}
          >
            <WaveformDecor />
          </div>

          {/* Corner LED indicators */}
          <div
            style={{
              position: "absolute",
              top: 24,
              left: 24,
              display: "flex",
              gap: 8,
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: LED_COLORS.green.on,
                boxShadow: LED_COLORS.green.glow,
              }}
            />
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: LED_COLORS.red.dim,
              }}
            />
          </div>
        </div>

        {/* ═══ RIGHT: AUTH FORM ═══ */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            padding: "clamp(32px, 5vw, 60px) clamp(24px, 4vw, 48px)",
            minHeight: "100vh",
          }}
        >
          <div style={{ width: "100%", maxWidth: 380 }}>
            {/* Logo header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 40,
              }}
            >
              <Logo
                color={LED_COLORS[accentColor].dim}
                w={32}
                h={23}
              />
              <LEDText
                color={accentColor}
                style={{
                  fontFamily: FONTS.mono,
                  fontWeight: 700,
                  fontSize: 16,
                  letterSpacing: -0.5,
                }}
              >
                DJToolKit
              </LEDText>
            </div>

            {/* Mode toggle */}
            <ModeToggle
              mode={mode}
              onSwitch={(m) => {
                setMode(m);
                setEmail("");
                setPassword("");
                setName("");
                setConfirmPw("");
              }}
            />

            {/* Form */}
            <form onSubmit={handleSubmit}>
              {!isLogin && (
                <AuthLEDInput
                  label="DJ Name"
                  type="text"
                  placeholder="Your name or alias"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  color={accentColor}
                  required
                />
              )}

              <AuthLEDInput
                label="Email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                color={accentColor}
                required
              />

              <AuthLEDInput
                label="Password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                color={accentColor}
                required
              />

              {!isLogin && (
                <AuthLEDInput
                  label="Confirm Password"
                  type="password"
                  placeholder="••••••••"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  color={accentColor}
                  required
                />
              )}

              {isLogin && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    marginBottom: 24,
                    marginTop: -8,
                  }}
                >
                  <LEDText
                    color="green"
                    style={{
                      fontFamily: FONTS.mono,
                      fontSize: 9,
                      letterSpacing: 1,
                      cursor: "pointer",
                    }}
                  >
                    FORGOT PASSWORD?
                  </LEDText>
                </div>
              )}

              <div style={{ marginTop: isLogin ? 0 : 8 }}>
                <SubmitButton
                  label={isLogin ? "LOG IN" : "CREATE ACCOUNT"}
                  loading={loading}
                  color={accentColor}
                />
              </div>
            </form>

            {/* Divider */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                margin: "28px 0",
              }}
            >
              <div
                style={{
                  height: 1,
                  flex: 1,
                  background: HARDWARE.borderLight,
                }}
              />
              <span
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 8,
                  color: HARDWARE.textDim,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              >
                or
              </span>
              <div
                style={{
                  height: 1,
                  flex: 1,
                  background: HARDWARE.borderLight,
                }}
              />
            </div>

            {/* Google OAuth button */}
            <button
              type="button"
              onClick={handleGoogleLogin}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                width: "100%",
                padding: "12px 0",
                background: HARDWARE.raised,
                border: `1.5px solid ${HARDWARE.borderLight}`,
                borderRadius: 3,
                color: HARDWARE.text,
                fontFamily: FONTS.mono,
                fontSize: "clamp(9px, 1.3vw, 11px)",
                fontWeight: 700,
                letterSpacing: 1,
                cursor: "pointer",
                transition: "all 0.2s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor =
                  HARDWARE.textDim;
                (e.currentTarget as HTMLButtonElement).style.background =
                  HARDWARE.border;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor =
                  HARDWARE.borderLight;
                (e.currentTarget as HTMLButtonElement).style.background =
                  HARDWARE.raised;
              }}
            >
              <GoogleIcon />
              Continue with Google
            </button>

            {/* Switch mode prompt */}
            <div style={{ textAlign: "center", marginTop: 24 }}>
              <span
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 10,
                  color: HARDWARE.textDim,
                  letterSpacing: 0.5,
                }}
              >
                {isLogin
                  ? "Don\u2019t have an account? "
                  : "Already have an account? "}
              </span>
              <span
                onClick={() => setMode(isLogin ? "signup" : "login")}
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 10,
                  fontWeight: 700,
                  color: LED_COLORS[isLogin ? "blue" : "green"].on,
                  textShadow: LED_COLORS[isLogin ? "blue" : "green"].glow,
                  cursor: "pointer",
                  letterSpacing: 1,
                }}
              >
                {isLogin ? "SIGN UP" : "LOG IN"}
              </span>
            </div>

            {/* Footer legal */}
            <div style={{ marginTop: 32, textAlign: "center" }}>
              <p
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 8,
                  color: HARDWARE.textDim,
                  letterSpacing: 0.5,
                  lineHeight: 1.6,
                }}
              >
                By continuing you agree to our
                <br />
                <LEDText
                  color={accentColor}
                  style={{ fontSize: 8, cursor: "pointer" }}
                >
                  Terms of Service
                </LEDText>
                {" & "}
                <LEDText
                  color={accentColor}
                  style={{ fontSize: 8, cursor: "pointer" }}
                >
                  Privacy Policy
                </LEDText>
              </p>
            </div>

            {/* Compatible strip */}
            <div
              style={{
                marginTop: 32,
                borderTop: `1px solid ${HARDWARE.borderLight}`,
                paddingTop: 16,
                display: "flex",
                alignItems: "center",
                gap: 12,
                justifyContent: "center",
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 7,
                  color: HARDWARE.textDim,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              >
                Works with
              </span>
              {["Rekordbox", "Serato", "Traktor"].map((n) => (
                <LEDText
                  key={n}
                  color={accentColor}
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 8,
                    letterSpacing: 1,
                  }}
                >
                  {n}
                </LEDText>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
