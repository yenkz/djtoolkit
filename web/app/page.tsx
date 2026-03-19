"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import Logo from "@/components/ui/Logo";
import LEDText from "@/components/ui/LEDText";
import CDJPlayButton from "@/components/ui/CDJPlayButton";
import LaunchPad from "@/components/ui/LaunchPad";
import PadHousing from "@/components/ui/PadHousing";
import JogWheel from "@/components/ui/JogWheel";
import VUMeter from "@/components/ui/VUMeter";
import TempoFader from "@/components/ui/TempoFader";
import ActionButton from "@/components/ui/ActionButton";
import { LED_COLORS, FONTS } from "@/lib/design-system/tokens";

// ─── Responsive hook ───
function useIsMobile() {
  const [m, setM] = useState(false);
  useEffect(() => {
    const check = () => setM(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return m;
}

// ─── Section divider ───
function Divider({ children, color = "green" }: { children: React.ReactNode; color?: "green" | "blue" | "orange" | "red" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: "clamp(16px, 3vw, 32px)" }}>
      <div style={{ height: 1, flex: 1, background: "var(--hw-border-light)" }} />
      <LEDText color={color} style={{ fontFamily: FONTS.mono, fontSize: "clamp(8px, 1.2vw, 9px)", letterSpacing: 3, textTransform: "uppercase" }}>{children}</LEDText>
      <div style={{ height: 1, flex: 1, background: "var(--hw-border-light)" }} />
    </div>
  );
}

// ─── Filter button (landing-only) ───
function FilterButton({ label, active = false, color = "green", onClick }: {
  label: string; active?: boolean; color?: "green" | "blue" | "orange" | "red"; onClick?: () => void;
}) {
  const [h, setH] = useState(false);
  const c = LED_COLORS[color];
  const lit = h || active;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        fontFamily: FONTS.mono,
        fontSize: "clamp(8px, 1.3vw, 10px)",
        fontWeight: 700,
        letterSpacing: 2,
        textTransform: "uppercase",
        padding: "8px 16px",
        cursor: "pointer",
        background: lit ? `${c.on}15` : "var(--hw-raised)",
        color: lit ? c.on : c.dim,
        border: `1.5px solid ${lit ? c.on + "55" : "var(--hw-border-light)"}`,
        textShadow: lit ? c.glow : "none",
        boxShadow: lit ? `0 0 12px ${c.on}22, inset 0 0 8px ${c.on}11` : `inset 0 1px 0 rgba(255,255,255,0.04)`,
        borderRadius: 3,
        transition: "all 0.2s",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

// ─── Pricing card ───
function PricingCard({ tier, price, desc, features, cta, color = "green", featured = false, href }: {
  tier: string; price: string; desc: string; features: string[]; cta: string;
  color?: "green" | "blue"; featured?: boolean; href: string;
}) {
  const [h, setH] = useState(false);
  const c = LED_COLORS[color];
  const lit = h || featured;
  return (
    <div
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        background: featured ? "var(--hw-surface)" : "var(--hw-raised)",
        border: `1.5px solid ${lit ? c.on + "33" : "var(--hw-border-light)"}`,
        padding: "clamp(20px, 4vw, 32px) clamp(16px, 3vw, 24px)",
        position: "relative",
        boxShadow: lit ? `0 0 24px ${c.on}11` : "none",
        transition: "all 0.3s",
      }}
    >
      {featured && (
        <div style={{
          position: "absolute", top: -10, right: 16,
          fontFamily: FONTS.mono, fontSize: 8, fontWeight: 700, letterSpacing: 1.5,
          background: c.on, color: "#141114", padding: "3px 10px", textTransform: "uppercase",
        }}>
          COMING SOON
        </div>
      )}
      <LEDText color={color} style={{ fontFamily: FONTS.mono, fontSize: 9, textTransform: "uppercase", letterSpacing: 2, display: "block", marginBottom: 8 }}>
        {tier}
      </LEDText>
      <div style={{ fontSize: "clamp(28px, 5vw, 40px)", fontWeight: 900, letterSpacing: -2, marginBottom: 4 }}>
        {price}
        {price !== "FREE" && <span style={{ fontSize: 13, fontWeight: 400, color: "var(--hw-text-dim)" }}>/yr</span>}
      </div>
      <p style={{ fontSize: 12, color: "var(--hw-text-dim)", lineHeight: 1.55, marginBottom: 16 }}>{desc}</p>
      <Link href={href}>
        <FilterButton label={cta} color={color} active={featured} />
      </Link>
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 5 }}>
        {features.map(f => (
          <span key={f} style={{
            fontFamily: FONTS.mono, fontSize: "clamp(8px, 1.2vw, 9px)",
            color: "var(--hw-text-dim)", letterSpacing: 0.5,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <div style={{
              width: 4, height: 4, borderRadius: "50%",
              background: lit ? c.on : c.dim,
              boxShadow: lit ? c.glow : "none",
              transition: "all 0.3s", flexShrink: 0,
            }} />
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// LANDING PAGE
// ═══════════════════════════════════════════
export default function LandingPage() {
  const [scrollY, setScrollY] = useState(0);
  const [user, setUser] = useState<boolean | null>(null);
  const [mounted, setMounted] = useState(false);
  const isMobile = useIsMobile();
  const c = LED_COLORS.green;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration guard + async auth check
    setMounted(true);
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setUser(!!data.user));
  }, []);

  useEffect(() => {
    const fn = () => setScrollY(window.scrollY);
    window.addEventListener("scroll", fn, { passive: true });
    return () => window.removeEventListener("scroll", fn);
  }, []);

  if (!mounted) return <div style={{ background: "var(--hw-body)", minHeight: "100vh" }} />;

  const ctaHref = user ? "/import" : "/login";
  const ctaLabel = user ? "DASHBOARD" : "GET STARTED";

  return (
    <div style={{ background: "var(--hw-body)", color: "var(--hw-text)", fontFamily: FONTS.sans, minHeight: "100vh", overflowX: "hidden" }}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        .hero-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: center; }
        .pricing-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .cta-grid { display: grid; grid-template-columns: 1.5fr 1fr; gap: 40px; align-items: end; }
        .footer-grid { display: grid; grid-template-columns: 1.5fr 1fr 1fr 1fr; gap: 24px; }
        .compat-strip { display: flex; align-items: center; gap: clamp(12px, 3vw, 28px); flex-wrap: wrap; }
        .deck-controls { display: flex; align-items: center; justify-content: center; gap: clamp(12px, 3vw, 28px); }
        .nav-links { display: flex; gap: 16px; align-items: center; }
        @media (max-width: 768px) {
          .hero-grid { grid-template-columns: 1fr; gap: 32px; }
          .pricing-grid { grid-template-columns: 1fr; }
          .cta-grid { grid-template-columns: 1fr; gap: 24px; }
          .footer-grid { grid-template-columns: 1fr 1fr; gap: 20px; }
          .nav-links > .nav-link-text { display: none; }
        }
      `}</style>

      {/* ═══ NAV ═══ */}
      <nav style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 100,
        background: scrollY > 40 ? "color-mix(in srgb, var(--hw-body) 93%, transparent)" : "var(--hw-surface)",
        backdropFilter: scrollY > 40 ? "blur(8px)" : "none",
        borderBottom: `1px solid ${scrollY > 40 ? "var(--hw-border-light)" : "var(--hw-border)"}`,
        transition: "all 0.3s",
      }}>
        <div style={{
          maxWidth: 1100, margin: "0 auto",
          padding: "0 clamp(16px, 3vw, 32px)",
          display: "flex", alignItems: "center", justifyContent: "space-between", height: 52,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Logo color={c.dim} w={isMobile ? 22 : 28} h={isMobile ? 16 : 20} />
            <LEDText color="green" style={{ fontFamily: FONTS.mono, fontWeight: 700, fontSize: "clamp(11px, 1.8vw, 14px)", letterSpacing: -0.5 }}>
              DJToolKit
            </LEDText>
          </div>
          <div className="nav-links">
            {["Features", "Pricing"].map(l => (
              <a key={l} href={`#${l.toLowerCase()}`} className="nav-link-text" style={{ textDecoration: "none" }}>
                <LEDText color="green" style={{ fontFamily: FONTS.mono, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5 }}>
                  {l}
                </LEDText>
              </a>
            ))}
            <Link href={ctaHref}>
              <FilterButton label={user ? "DASHBOARD" : "SIGN IN"} color="green" />
            </Link>
          </div>
        </div>
      </nav>

      {/* ═══ HERO ═══ */}
      <section style={{ maxWidth: 1100, margin: "0 auto", padding: "clamp(80px, 12vw, 100px) clamp(16px, 3vw, 32px) clamp(32px, 5vw, 48px)" }}>
        <div className="hero-grid">
          <div>
            <LEDText color="green" style={{
              fontFamily: FONTS.mono, fontSize: "clamp(8px, 1.3vw, 10px)",
              textTransform: "uppercase", letterSpacing: 3, display: "block", marginBottom: 16,
            }}>
              [ DJ Library Management ]
            </LEDText>
            <h1 style={{
              fontSize: "clamp(32px, 7vw, 68px)", fontWeight: 900,
              lineHeight: 0.92, letterSpacing: "-0.04em",
              marginBottom: "clamp(16px, 3vw, 24px)",
            }}>
              CURATE YOUR<br />LIBRARY{" "}
              <LEDText color="green" alwaysOn style={{ fontSize: "inherit", fontWeight: "inherit" }}>
                SMARTER
              </LEDText>
              <span style={{ color: LED_COLORS.red.on, textShadow: LED_COLORS.red.glow }}>.</span>
            </h1>
            <p style={{
              fontSize: "clamp(13px, 2vw, 15px)", lineHeight: 1.65,
              color: "var(--hw-text-dim)", maxWidth: 400,
              marginBottom: "clamp(20px, 4vw, 32px)",
            }}>
              Make music available, enrich every track with metadata, and keep your library organized across Rekordbox, Serato, and Traktor.
            </p>
            <Link href={ctaHref} style={{ textDecoration: "none" }}>
              <CDJPlayButton size={isMobile ? 60 : 80} label={ctaLabel} />
            </Link>
          </div>

          <div className="deck-controls">
            {!isMobile && <VUMeter level={0.75} segments={10} height={160} />}
            <JogWheel />
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <TempoFader label="TEMPO" initial={128} min={70} max={180} unit="BPM" />
              {!isMobile && <TempoFader label="MASTER" initial={80} min={0} max={100} unit="%" />}
            </div>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--hw-border-light)", marginTop: "clamp(24px, 5vw, 48px)", paddingTop: 14 }}>
          <div className="compat-strip">
            <LEDText color="green" style={{ fontFamily: FONTS.mono, fontSize: "clamp(7px, 1vw, 8px)", textTransform: "uppercase", letterSpacing: 2, whiteSpace: "nowrap" }}>
              Compatible
            </LEDText>
            {["Rekordbox", "Serato", "Traktor", "VirtualDJ", "Engine DJ"].map(n => (
              <LEDText key={n} color="green" style={{ fontFamily: FONTS.mono, fontSize: "clamp(8px, 1.3vw, 10px)", letterSpacing: 1 }}>
                {n}
              </LEDText>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ FEATURES JOURNEY ═══ */}
      <section id="features" style={{ maxWidth: 1100, margin: "0 auto", padding: "clamp(24px, 5vw, 48px) clamp(16px, 3vw, 32px)" }}>
        <Divider color="green">[ Your Journey ]</Divider>
        <PadHousing cols={4} mobileCols={2} label="Import → Organize → Export → Discover">
          <LaunchPad label="Import" sublabel="Make music available" color="green" size={isMobile ? "medium" : "large"} />
          <LaunchPad label="Organize" sublabel="AI metadata & dedup" color="blue" size={isMobile ? "medium" : "large"} />
          <LaunchPad label="Export" sublabel="Rekordbox · Serato · Traktor" color="orange" size={isMobile ? "medium" : "large"} />
          <LaunchPad label="Discover" sublabel="Smart recommendations" color="red" size={isMobile ? "medium" : "large"} />
        </PadHousing>
      </section>

      {/* ═══ TOOLS ═══ */}
      <section style={{ maxWidth: 1100, margin: "0 auto", padding: "clamp(16px, 3vw, 24px) clamp(16px, 3vw, 32px) clamp(32px, 5vw, 48px)" }}>
        <Divider color="orange">[ Hot Cues ]</Divider>
        <PadHousing cols={6} mobileCols={3} label="Tools — Hover to preview">
          <LaunchPad label="TAG" sublabel="BPM + Key" color="green" size="small" />
          <LaunchPad label="ART" sublabel="Cover Art" color="green" size="small" />
          <LaunchPad label="DEDUP" sublabel="Fingerprint" color="red" size="small" />
          <LaunchPad label="GENRE" sublabel="AI Detect" color="orange" size="small" />
          <LaunchPad label="SORT" sublabel="Harmonic" color="blue" size="small" />
          <LaunchPad label="SYNC" sublabel="Export" color="blue" size="small" />
        </PadHousing>
      </section>

      {/* ═══ COMING SOON ═══ */}
      <section style={{ maxWidth: 1100, margin: "0 auto", padding: "clamp(32px, 5vw, 48px) clamp(16px, 3vw, 32px)" }}>
        <Divider color="blue">[ Coming Soon ]</Divider>
        <PadHousing cols={3} mobileCols={3} label="On the roadmap">
          <LaunchPad label="Smart Cues" sublabel="Auto-detect transitions" color="blue" size="medium" />
          <LaunchPad label="Set Builder" sublabel="Design sets like stories" color="blue" size="medium" />
          <LaunchPad label="Purchase Router" sublabel="Find the best price" color="blue" size="medium" />
        </PadHousing>
      </section>

      {/* ═══ PRICING ═══ */}
      <section id="pricing" style={{ maxWidth: 1100, margin: "0 auto", padding: "clamp(32px, 5vw, 48px) clamp(16px, 3vw, 32px)" }}>
        <Divider color="green">[ Select Source ]</Divider>
        <div className="pricing-grid" style={{ maxWidth: 620 }}>
          <PricingCard
            tier="USB-A"
            price="FREE"
            desc="Full access while in beta. No limits."
            cta="GET STARTED"
            color="green"
            href={ctaHref}
            features={[
              "Unlimited tracks",
              "BPM + key detection",
              "Audio fingerprinting",
              "Cover art fetching",
              "Rekordbox export",
              "Serato + Traktor export",
            ]}
          />
          <PricingCard
            tier="PRO DJ LINK"
            price="TBD"
            desc="Advanced features when we launch."
            cta="NOTIFY ME"
            color="blue"
            featured
            href={ctaHref}
            features={[
              "Everything in Free",
              "Smart cue points",
              "Set builder",
              "Purchase router",
              "Graph playlists",
              "Cloud sync",
            ]}
          />
        </div>
        <p style={{ fontFamily: FONTS.mono, fontSize: 9, color: "var(--hw-text-dim)", marginTop: 14, letterSpacing: 1 }}>
          Free during beta. No credit card required.
        </p>
      </section>

      {/* ═══ CTA ═══ */}
      <section style={{ maxWidth: 1100, margin: "0 auto", padding: "clamp(32px, 5vw, 48px) clamp(16px, 3vw, 32px) clamp(48px, 8vw, 80px)" }}>
        <div style={{ borderTop: "1px solid var(--hw-border-light)", paddingTop: "clamp(24px, 5vw, 48px)" }}>
          <div className="cta-grid">
            <h2 style={{
              fontSize: "clamp(28px, 5vw, 60px)", fontWeight: 900,
              lineHeight: 0.92, letterSpacing: "-0.04em",
            }}>
              READY TO<br />DROP THE<br />NEEDLE
              <span style={{ color: LED_COLORS.red.on, textShadow: LED_COLORS.red.glow }}>?</span>
            </h2>
            <div>
              <p style={{ fontSize: "clamp(12px, 2vw, 14px)", color: "var(--hw-text-dim)", lineHeight: 1.6, marginBottom: 20 }}>
                Free to start. No credit card required.
              </p>
              <Link href={ctaHref} style={{ textDecoration: "none" }}>
                <CDJPlayButton size={isMobile ? 56 : 72} label={`${ctaLabel} FREE`} />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ═══ FOOTER ═══ */}
      <footer style={{ maxWidth: 1100, margin: "0 auto", padding: "0 clamp(16px, 3vw, 32px) 32px" }}>
        <div style={{ borderTop: "1px solid var(--hw-border-light)", paddingTop: 24 }}>
          <div className="footer-grid">
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <Logo color={c.dim} w={22} h={16} />
                <LEDText color="green" style={{ fontFamily: FONTS.mono, fontWeight: 700, fontSize: 12 }}>DJToolKit</LEDText>
              </div>
              <p style={{ fontFamily: FONTS.mono, fontSize: 9, color: "var(--hw-text-dim)", letterSpacing: 1 }}>
                Import. Organize. Play.
              </p>
            </div>
            {[
              { t: "Features", l: ["Import", "Organize", "Export", "Tagging"] },
              { t: "Tools", l: ["BPM/Key", "Fingerprint", "Cover Art", "Genre AI"] },
              { t: "Legal", l: ["Privacy", "Terms"] },
            ].map(col => (
              <div key={col.t}>
                <LEDText color="green" style={{ fontFamily: FONTS.mono, fontSize: 8, textTransform: "uppercase", letterSpacing: 2, display: "block", marginBottom: 8 }}>
                  {col.t}
                </LEDText>
                {col.l.map(l => (
                  <LEDText key={l} color="green" style={{ fontFamily: FONTS.mono, display: "block", fontSize: 10, marginBottom: 5 }}>
                    {l}
                  </LEDText>
                ))}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 24, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <span style={{ fontFamily: FONTS.mono, fontSize: 9, color: "var(--hw-text-dim)" }}>
              © 2026 DJToolKit
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
