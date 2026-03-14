"use client";
import { useState, useEffect, useRef } from "react";

// ═══════════════════════════════════════════
// THEMES
// ═══════════════════════════════════════════
const THEMES = {
  light: {
    bg: "#EBEED5",
    text: "#332634",
    accent: "#332634",
    accentSoft: "#33263444",
    muted: "#908068",
    cardBg: "rgba(51,38,52,0.04)",
    cardBorder: "rgba(51,38,52,0.15)",
    proBg: "#332634",
    proText: "#EBEED5",
    proBtn: "#EBEED5",
    proBtnText: "#332634",
  },
  dark: {
    bg: "#1E1A1F",
    text: "#EBEED5",
    accent: "#EBEED5",
    accentSoft: "#EBEED544",
    muted: "#908068",
    cardBg: "rgba(235,238,213,0.04)",
    cardBorder: "rgba(235,238,213,0.12)",
    proBg: "#EBEED5",
    proText: "#1E1A1F",
    proBtn: "#1E1A1F",
    proBtnText: "#EBEED5",
  },
};

// ═══════════════════════════════════════════
// HOOKS
// ═══════════════════════════════════════════
const useInView = (threshold = 0.15) => {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setInView(true); }, { threshold });
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return [ref, inView];
};

const useScrollY = () => {
  const [y, setY] = useState(0);
  useEffect(() => {
    const fn = () => setY(window.scrollY);
    window.addEventListener("scroll", fn, { passive: true });
    return () => window.removeEventListener("scroll", fn);
  }, []);
  return y;
};

// ═══════════════════════════════════════════
// GRAIN OVERLAY
// ═══════════════════════════════════════════
const GrainOverlay = () => {
  const canvasRef = useRef(null);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    c.width = 256; c.height = 256;
    const img = ctx.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v;
      img.data[i + 3] = 16;
    }
    ctx.putImageData(img, 0, 0);
  }, []);
  return (
    <canvas ref={canvasRef} style={{
      position: "fixed", inset: 0, width: "100%", height: "100%",
      pointerEvents: "none", zIndex: 9999, opacity: 0.45, mixBlendMode: "multiply",
    }} />
  );
};

// ═══════════════════════════════════════════
// TYPING HEADLINE
// ═══════════════════════════════════════════
const TypingHeadline = ({ text, style, t }) => {
  const [ref, inView] = useInView(0.2);
  const [len, setLen] = useState(0);
  const fullText = text.replace(/<br\s*\/?>/g, "\n");

  useEffect(() => {
    if (!inView) return;
    setLen(0);
    let i = 0;
    const iv = setInterval(() => { i++; setLen(i); if (i >= fullText.length) clearInterval(iv); }, 35);
    return () => clearInterval(iv);
  }, [inView, fullText]);

  const displayed = fullText.slice(0, len);
  const showCursor = len < fullText.length && inView;

  return (
    <div ref={ref} style={style}>
      {displayed.split("\n").map((line, i, arr) => (
        <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
      ))}
      <span style={{
        display: "inline-block", width: 3, height: "0.85em", marginLeft: 2,
        background: t.accent, opacity: showCursor ? 1 : 0,
        animation: showCursor ? "blink 0.6s step-end infinite" : "none",
        verticalAlign: "baseline", position: "relative", top: 2,
      }} />
    </div>
  );
};

// ═══════════════════════════════════════════
// GLITCH TEXT
// ═══════════════════════════════════════════
const GlitchText = ({ children, t }) => {
  const [glitch, setGlitch] = useState(false);
  useEffect(() => {
    const trigger = () => { setGlitch(true); setTimeout(() => setGlitch(false), 150); };
    const iv = setInterval(trigger, 3000 + Math.random() * 4000);
    return () => clearInterval(iv);
  }, []);
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      {children}
      {glitch && (
        <>
          <span style={{ position: "absolute", top: -1, left: 2, right: -2, color: t.muted, clipPath: "inset(15% 0 60% 0)", opacity: 0.7 }}>{children}</span>
          <span style={{ position: "absolute", top: 1, left: -2, right: 2, color: t.accent, clipPath: "inset(55% 0 10% 0)", opacity: 0.5 }}>{children}</span>
        </>
      )}
    </span>
  );
};

// ═══════════════════════════════════════════
// HOVER REVEAL
// ═══════════════════════════════════════════
const HoverReveal = ({ label, children, t }) => {
  const [hovered, setHovered] = useState(false);
  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        border: `1.5px solid ${t.cardBorder}`, padding: "28px 24px", cursor: "default",
        background: hovered ? t.cardBg : "transparent", transition: "background 0.3s", margin: "-0.75px",
      }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: hovered ? 12 : 0, transition: "margin 0.3s" }}>
        <span style={{ fontFamily: "'Space Mono'", fontSize: 9, textTransform: "uppercase", letterSpacing: 2, color: t.muted }}>{label}</span>
        <span style={{ fontFamily: "'Space Mono'", fontSize: 11, color: t.muted, transition: "transform 0.3s", transform: hovered ? "rotate(45deg)" : "none" }}>+</span>
      </div>
      <div style={{ maxHeight: hovered ? 200 : 0, overflow: "hidden", opacity: hovered ? 1 : 0, transition: "max-height 0.4s cubic-bezier(.23,1,.32,1), opacity 0.3s ease" }}>
        {children}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════
// PARALLAX
// ═══════════════════════════════════════════
const Parallax = ({ children, speed = 0.1, style = {} }) => {
  const scrollY = useScrollY();
  const ref = useRef(null);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    setOffset((window.innerHeight / 2 - center) * speed);
  }, [scrollY, speed]);
  return <div ref={ref} style={{ ...style, transform: `translateY(${offset}px)`, willChange: "transform" }}>{children}</div>;
};

// ═══════════════════════════════════════════
// FADE
// ═══════════════════════════════════════════
const Fade = ({ children, style = {}, delay = 0 }) => {
  const [ref, inView] = useInView(0.1);
  return (
    <div ref={ref} style={{ ...style, opacity: inView ? 1 : 0, transform: inView ? "translateY(0)" : "translateY(24px)", transition: `opacity 0.5s ease ${delay}ms, transform 0.5s ease ${delay}ms` }}>
      {children}
    </div>
  );
};

// ═══════════════════════════════════════════
// VISUALIZATIONS
// ═══════════════════════════════════════════
const WaveformBars = ({ count = 64, height = 120, t }) => {
  const [ref, inView] = useInView(0.2);
  const bars = useRef(Array.from({ length: count }, (_, i) => {
    const pos = i / count;
    const env = Math.sin(pos * Math.PI);
    return { h: Math.max(3, env * (0.2 + Math.random() * 0.8) * height), delay: i * 12 };
  })).current;
  return (
    <div ref={ref} style={{ display: "flex", alignItems: "flex-end", gap: 1.5, height }}>
      {bars.map((b, i) => (
        <div key={i} style={{ flex: 1, background: t.accent, height: inView ? b.h : 0, opacity: inView ? 0.65 : 0, transition: `height 0.6s cubic-bezier(.23,1,.32,1) ${b.delay}ms, opacity 0.4s ease ${b.delay}ms` }} />
      ))}
    </div>
  );
};

const ChapterStrip = ({ t }) => {
  const [ref, inView] = useInView(0.15);
  const ch = [
    { label: "WARM UP", w: 15, h: 30 }, { label: "BUILD", w: 25, h: 55 },
    { label: "PEAK", w: 35, h: 95 }, { label: "COOL", w: 25, h: 40 },
  ];
  return (
    <div ref={ref} style={{ display: "flex", gap: 2, height: 180, width: "100%", border: `1.5px solid ${t.accentSoft}` }}>
      {ch.map((c, i) => (
        <div key={i} style={{ flex: c.w, display: "flex", flexDirection: "column", justifyContent: "flex-end", borderRight: i < 3 ? `1px solid ${t.accent}18` : "none", padding: "0 0 8px 8px", opacity: inView ? 1 : 0, transition: `opacity 0.4s ease ${i * 120}ms` }}>
          <div style={{ height: inView ? `${c.h}%` : "0%", background: t.accent, opacity: c.label === "PEAK" ? 0.7 : 0.25, transition: `height 0.8s ease ${300 + i * 120}ms`, marginBottom: 6 }} />
          <span style={{ fontFamily: "'Space Mono'", fontSize: 8, letterSpacing: 1.5, color: t.muted }}>{c.label}</span>
        </div>
      ))}
    </div>
  );
};

const GraphNet = ({ t }) => {
  const [ref, inView] = useInView(0.15);
  const nodes = [{ x: 50, y: 25 }, { x: 22, y: 50 }, { x: 75, y: 48 }, { x: 38, y: 78 }, { x: 68, y: 18 }, { x: 12, y: 28 }, { x: 82, y: 72 }, { x: 55, y: 58 }];
  const edges = [[0, 1], [0, 2], [1, 3], [2, 3], [0, 4], [4, 2], [5, 1], [5, 0], [6, 2], [6, 3], [7, 0], [7, 2]];
  return (
    <div ref={ref} style={{ position: "relative", width: "100%", aspectRatio: "1/1", border: `1.5px solid ${t.accentSoft}` }}>
      <svg width="100%" height="100%" viewBox="0 0 100 100" style={{ position: "absolute", inset: 0 }}>
        {edges.map(([a, b], i) => (
          <line key={i} x1={nodes[a].x} y1={nodes[a].y} x2={nodes[b].x} y2={nodes[b].y} stroke={t.accent} strokeWidth="0.4" opacity={inView ? 0.2 : 0} style={{ transition: `opacity 0.6s ease ${150 + i * 60}ms` }} />
        ))}
        {nodes.map((n, i) => (
          <rect key={i} x={n.x - 2.5} y={n.y - 2.5} width="5" height="5" fill={i % 2 === 0 ? t.accent : t.muted} opacity={inView ? 0.7 : 0} style={{ transition: `opacity 0.4s ease ${i * 100}ms` }} />
        ))}
      </svg>
    </div>
  );
};

const ScatterDots = ({ t }) => {
  const [ref, inView] = useInView(0.15);
  const dots = useRef(Array.from({ length: 90 }, () => ({
    x: 4 + Math.random() * 92, y: 4 + Math.random() * 92, r: 2 + Math.random() * 3.5, delay: Math.random() * 900, isAccent: Math.random() > 0.5,
  }))).current;
  return (
    <div ref={ref} style={{ position: "relative", width: "100%", aspectRatio: "1/1", border: `1.5px solid ${t.accentSoft}` }}>
      {dots.map((d, i) => (
        <div key={i} style={{ position: "absolute", left: `${d.x}%`, top: `${d.y}%`, width: d.r * 2, height: d.r * 2, background: d.isAccent ? t.accent : t.muted, opacity: inView ? (d.isAccent ? 0.6 : 0.25) : 0, transform: inView ? "scale(1)" : "scale(0)", transition: `all 0.4s ease ${d.delay}ms` }} />
      ))}
      <div style={{ position: "absolute", left: 0, top: "50%", right: 0, height: 1, background: `${t.accent}15` }} />
      <div style={{ position: "absolute", top: 0, left: "50%", bottom: 0, width: 1, background: `${t.accent}15` }} />
      <span style={{ position: "absolute", bottom: 6, right: 8, fontFamily: "'Space Mono'", fontSize: 9, color: t.muted, textTransform: "uppercase", letterSpacing: 1 }}>bpm →</span>
      <span style={{ position: "absolute", top: 8, left: 8, fontFamily: "'Space Mono'", fontSize: 9, color: t.muted, textTransform: "uppercase", letterSpacing: 1, writingMode: "vertical-lr" }}>energy →</span>
    </div>
  );
};

// ═══════════════════════════════════════════
// LOGO
// ═══════════════════════════════════════════
const Logo = ({ color, w = 28, h = 20 }) => (
  <svg width={w} height={h} viewBox="0 0 60 40" fill="none">
    <path d="M2 22c1.5-1 3-3 4.5-5s2.5 1 3.5 4c1.2 3.5 2 6 3.5 3s3-10 4.5-15c1.8-6 2.5-8 4 0s2.5 14 4 18c1.2 3 2 4 3.5-1s3-12 4.5-16c1.3-3.5 2-4 3 0s2 8 3 11c.8 2.2 1.5 3 2.5 0s2-6.5 3-8c.7-1 1.2-.5 2 .5s1.5 2 2.5 2.5c1 .5 2.5.2 4 0s3-.5 4.5-.3" stroke={color} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);

// ═══════════════════════════════════════════
// THEME TOGGLE ICON
// ═══════════════════════════════════════════
const ThemeToggle = ({ isDark, onClick, color }) => (
  <button onClick={onClick} aria-label="Toggle theme" style={{
    background: "none", border: `1.5px solid ${color}44`, width: 36, height: 36,
    display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", transition: "border-color 0.2s",
  }}
    onMouseEnter={e => e.currentTarget.style.borderColor = color}
    onMouseLeave={e => e.currentTarget.style.borderColor = `${color}44`}
  >
    {isDark ? (
      /* Sun */
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    ) : (
      /* Moon */
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
        <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
      </svg>
    )}
  </button>
);

// ═══════════════════════════════════════════
// TESTIMONIALS
// ═══════════════════════════════════════════
const testimonials = [
  { name: "Sara Méndez", role: "House — Barcelona", quote: "I prep my weekend sets in half the time. No fluff, just works." },
  { name: "Marcus Vane", role: "Techno — Berlin", quote: "The graph view surfaced connections I'd never have found scrolling lists." },
  { name: "Yuki Tanaka", role: "Open Format — Tokyo", quote: "Moved 12k tracks over in minutes. Clean, fast, no bloat." },
  { name: "Leo Fischer", role: "Vinyl+Digital — Munich", quote: "Chapter planning gave my festival sets a real narrative arc." },
];

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════
export default function App() {
  const [isDark, setIsDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setIsDark(mq.matches);
    const handler = (e) => setIsDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const t = isDark ? THEMES.dark : THEMES.light;
  const [tIdx, setTIdx] = useState(0);
  const scrollY = useScrollY();
  const mono = "'Space Mono', monospace";

  useEffect(() => {
    const iv = setInterval(() => setTIdx(p => (p + 1) % testimonials.length), 4500);
    return () => clearInterval(iv);
  }, []);

  // Prevent hydration mismatch flash
  if (!mounted) {
    return (
      <div style={{ background: "#EBEED5", minHeight: "100vh" }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
      </div>
    );
  }

  return (
    <div style={{ background: t.bg, color: t.text, fontFamily: "'DM Sans', sans-serif", minHeight: "100vh", transition: "background 0.4s ease, color 0.4s ease", position: "relative" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
      <style>{`
        @keyframes blink { 0%,100% { opacity:1 } 50% { opacity:0 } }
        * { box-sizing:border-box; margin:0; padding:0 }
        ::selection { background: ${t.accent}22 }
      `}</style>

      <GrainOverlay />

      {/* ═══ NAV ═══ */}
      <nav style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 100,
        background: scrollY > 40 ? `${t.bg}ee` : "transparent",
        backdropFilter: scrollY > 40 ? "blur(8px)" : "none",
        WebkitBackdropFilter: scrollY > 40 ? "blur(8px)" : "none",
        borderBottom: `1.5px solid ${scrollY > 40 ? `${t.accent}22` : "transparent"}`,
        transition: "all 0.3s",
      }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 32px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Logo color={t.text} />
            <span style={{ fontFamily: mono, fontWeight: 700, fontSize: 14, letterSpacing: -0.5 }}>DJToolKit</span>
          </div>
          <div style={{ display: "flex", gap: 28, alignItems: "center" }}>
            {["Features", "Pricing", "Blog"].map(l => (
              <a key={l} href="#" style={{ fontFamily: mono, fontSize: 11, color: t.text, textDecoration: "none", textTransform: "uppercase", letterSpacing: 1.5, opacity: 0.5, transition: "opacity 0.2s" }}
                onMouseEnter={e => e.target.style.opacity = 1} onMouseLeave={e => e.target.style.opacity = 0.5}>{l}</a>
            ))}
            <ThemeToggle isDark={isDark} onClick={() => setIsDark(!isDark)} color={t.text} />
            <button style={{
              fontFamily: mono, fontSize: 11, background: t.accent, color: t.bg,
              border: "none", padding: "8px 20px", cursor: "pointer",
              textTransform: "uppercase", letterSpacing: 1.5, transition: "opacity 0.2s",
            }} onMouseEnter={e => e.target.style.opacity = 0.8} onMouseLeave={e => e.target.style.opacity = 1}>Sign up</button>
          </div>
        </div>
      </nav>

      {/* ═══ HERO ═══ */}
      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "140px 32px 80px" }}>
        <Fade>
          <div style={{ fontFamily: mono, fontSize: 11, textTransform: "uppercase", letterSpacing: 3, color: t.muted, marginBottom: 20 }}>
            [ Music Curation Platform ]
          </div>
        </Fade>
        <Fade delay={100}>
          <TypingHeadline text="PREP YOUR<br />SETS FASTER." t={t}
            style={{ fontSize: "clamp(48px, 7vw, 96px)", fontWeight: 900, lineHeight: 0.92, letterSpacing: -3 }} />
        </Fade>
        <div style={{ height: 32 }} />
        <Fade delay={200} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 48, alignItems: "end" }}>
          <div>
            <p style={{ fontSize: 16, lineHeight: 1.65, color: t.muted, maxWidth: 420, marginBottom: 32 }}>
              Organize crates, discover connections between tracks, and design sets that flow like a story. Built for DJs who'd rather be mixing than managing files.
            </p>
            <div style={{ display: "flex", gap: 12 }}>
              <button style={{
                fontFamily: mono, fontSize: 11, background: t.accent, color: t.bg,
                border: `2px solid ${t.accent}`, padding: "12px 28px", cursor: "pointer",
                textTransform: "uppercase", letterSpacing: 1.5, transition: "all 0.2s",
              }}
                onMouseEnter={e => { e.target.style.background = "transparent"; e.target.style.color = t.accent; }}
                onMouseLeave={e => { e.target.style.background = t.accent; e.target.style.color = t.bg; }}
              >Get started →</button>
              <button style={{
                fontFamily: mono, fontSize: 11, background: "transparent", color: t.text,
                border: `1.5px solid ${t.accentSoft}`, padding: "12px 28px", cursor: "pointer",
                textTransform: "uppercase", letterSpacing: 1.5, transition: "all 0.2s",
              }}
                onMouseEnter={e => e.target.style.borderColor = t.accent}
                onMouseLeave={e => e.target.style.borderColor = t.accentSoft}
              >Watch demo</button>
            </div>
          </div>
          <Parallax speed={-0.08}>
            <WaveformBars count={72} height={140} t={t} />
          </Parallax>
        </Fade>
        <div style={{ borderTop: `1.5px solid ${t.accentSoft}`, marginTop: 48 }} />
        <Fade delay={300} style={{ display: "flex", alignItems: "center", gap: 32, paddingTop: 20 }}>
          <span style={{ fontFamily: mono, fontSize: 9, textTransform: "uppercase", letterSpacing: 2, color: t.muted, whiteSpace: "nowrap" }}>Works with</span>
          {["Rekordbox", "Serato", "Traktor", "VirtualDJ", "Engine DJ"].map(n => (
            <span key={n} style={{ fontFamily: mono, fontSize: 11, color: t.text, opacity: 0.3, letterSpacing: 0.5 }}>{n}</span>
          ))}
        </Fade>
      </section>

      {/* ═══ FEATURES ═══ */}
      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "80px 32px" }}>
        <Fade>
          <div style={{ fontFamily: mono, fontSize: 9, textTransform: "uppercase", letterSpacing: 3, color: t.muted, marginBottom: 12 }}>[ 01 / Features ]</div>
          <div style={{ borderTop: `1.5px solid ${t.accentSoft}`, marginBottom: 48 }} />
        </Fade>

        {/* Chapter Builder */}
        <Fade style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, marginBottom: 64 }}>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <span style={{ fontFamily: mono, fontSize: 9, textTransform: "uppercase", letterSpacing: 2, color: t.muted, marginBottom: 12 }}>Chapter Builder</span>
            <h2 style={{ fontSize: "clamp(28px, 3.5vw, 44px)", fontWeight: 900, lineHeight: 0.95, letterSpacing: -1.5, marginBottom: 16 }}>
              <GlitchText t={t}>BUILD SETS</GlitchText><br />LIKE STORIES
            </h2>
            <p style={{ fontSize: 14, lineHeight: 1.65, color: t.muted, maxWidth: 380, marginBottom: 20 }}>
              Segment your set into energy blocks. Warm up, build, peak, cooldown. Export directly to your DJ software.
            </p>
            <a href="#" style={{ fontFamily: mono, fontSize: 10, color: t.accent, textDecoration: "none", textTransform: "uppercase", letterSpacing: 1.5, borderBottom: `1px solid ${t.accent}`, paddingBottom: 2, alignSelf: "flex-start" }}>Learn more →</a>
          </div>
          <Parallax speed={0.06}><ChapterStrip t={t} /></Parallax>
        </Fade>

        {/* Graph */}
        <Fade style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, marginBottom: 64 }}>
          <Parallax speed={0.05} style={{ maxWidth: 400 }}><GraphNet t={t} /></Parallax>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <span style={{ fontFamily: mono, fontSize: 9, textTransform: "uppercase", letterSpacing: 2, color: t.muted, marginBottom: 12 }}>Graph Playlists</span>
            <h2 style={{ fontSize: "clamp(28px, 3.5vw, 44px)", fontWeight: 900, lineHeight: 0.95, letterSpacing: -1.5, marginBottom: 16 }}>
              FIND <GlitchText t={t}>HIDDEN</GlitchText><br />CONNECTIONS
            </h2>
            <p style={{ fontSize: 14, lineHeight: 1.65, color: t.muted, maxWidth: 380, marginBottom: 20 }}>
              Tracks connect by harmony, energy, and emotion. Rediscover gems buried in forgotten folders.
            </p>
            <a href="#" style={{ fontFamily: mono, fontSize: 10, color: t.accent, textDecoration: "none", textTransform: "uppercase", letterSpacing: 1.5, borderBottom: `1px solid ${t.accent}`, paddingBottom: 2, alignSelf: "flex-start" }}>Learn more →</a>
          </div>
        </Fade>

        {/* Scatter */}
        <Fade style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32 }}>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <span style={{ fontFamily: mono, fontSize: 9, textTransform: "uppercase", letterSpacing: 2, color: t.muted, marginBottom: 12 }}>Scatter Map</span>
            <h2 style={{ fontSize: "clamp(28px, 3.5vw, 44px)", fontWeight: 900, lineHeight: 0.95, letterSpacing: -1.5, marginBottom: 16 }}>
              NAVIGATE<br /><GlitchText t={t}>YOUR SOUND</GlitchText>
            </h2>
            <p style={{ fontSize: 14, lineHeight: 1.65, color: t.muted, maxWidth: 380, marginBottom: 20 }}>
              Every track plotted in space. Distance = difference. Proximity = compatibility.
            </p>
            <a href="#" style={{ fontFamily: mono, fontSize: 10, color: t.accent, textDecoration: "none", textTransform: "uppercase", letterSpacing: 1.5, borderBottom: `1px solid ${t.accent}`, paddingBottom: 2, alignSelf: "flex-start" }}>Learn more →</a>
          </div>
          <Parallax speed={0.07} style={{ maxWidth: 400 }}><ScatterDots t={t} /></Parallax>
        </Fade>
      </section>

      {/* ═══ TOOLS — HOVER REVEAL ═══ */}
      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "80px 32px" }}>
        <Fade>
          <div style={{ fontFamily: mono, fontSize: 9, textTransform: "uppercase", letterSpacing: 3, color: t.muted, marginBottom: 12 }}>[ 02 / Tools ]</div>
          <div style={{ borderTop: `1.5px solid ${t.accentSoft}`, marginBottom: 48 }} />
        </Fade>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 2 }}>
          {[
            { n: "01 — Smart Tagging", d: "Auto-detect BPM, key, energy. Custom tags for instant recall." },
            { n: "02 — One-Click Sync", d: "Push crates to USB, cloud, or DJ software. Zero friction." },
            { n: "03 — Cue Points", d: "Mark drops, breakdowns, transitions. Visual timeline per track." },
            { n: "04 — Genre Detection", d: "AI-powered genre classification across your full library." },
            { n: "05 — Magic Sorting", d: "Order tracks by harmonic compatibility, energy, or mood." },
            { n: "06 — Cloud Backup", d: "Your library travels with you. Any device, anywhere." },
          ].map((f, i) => (
            <HoverReveal key={i} label={f.n} t={t}>
              <p style={{ fontSize: 13, lineHeight: 1.55, color: t.muted }}>{f.d}</p>
            </HoverReveal>
          ))}
        </div>
      </section>

      {/* ═══ TESTIMONIALS ═══ */}
      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "80px 32px" }}>
        <Fade>
          <div style={{ fontFamily: mono, fontSize: 9, textTransform: "uppercase", letterSpacing: 3, color: t.muted, marginBottom: 12 }}>[ 03 / DJs ]</div>
          <div style={{ borderTop: `1.5px solid ${t.accentSoft}`, marginBottom: 48 }} />
        </Fade>
        <div style={{ maxWidth: 600, minHeight: 160, position: "relative" }}>
          {testimonials.map((te, i) => (
            <div key={i} style={{
              opacity: tIdx === i ? 1 : 0, transform: tIdx === i ? "none" : "translateY(8px)",
              transition: "all 0.4s ease", position: tIdx === i ? "relative" : "absolute",
              top: 0, left: 0, right: 0, pointerEvents: tIdx === i ? "auto" : "none",
            }}>
              <p style={{ fontSize: "clamp(22px, 2.8vw, 32px)", fontWeight: 700, lineHeight: 1.25, letterSpacing: -0.8, marginBottom: 20 }}>"{te.quote}"</p>
              <div style={{ fontFamily: mono, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5 }}>
                {te.name} <span style={{ color: t.muted }}>— {te.role}</span>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4, marginTop: 32 }}>
          {testimonials.map((_, i) => (
            <button key={i} onClick={() => setTIdx(i)} style={{
              width: tIdx === i ? 32 : 12, height: 3, background: tIdx === i ? t.accent : t.accentSoft,
              border: "none", cursor: "pointer", transition: "all 0.3s",
            }} />
          ))}
        </div>
      </section>

      {/* ═══ PRICING ═══ */}
      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "80px 32px" }}>
        <Fade>
          <div style={{ fontFamily: mono, fontSize: 9, textTransform: "uppercase", letterSpacing: 3, color: t.muted, marginBottom: 12 }}>[ 04 / Pricing ]</div>
          <div style={{ borderTop: `1.5px solid ${t.accentSoft}`, marginBottom: 48 }} />
        </Fade>
        <Fade style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, maxWidth: 700 }}>
          {/* Free */}
          <div style={{ border: `1.5px solid ${t.accentSoft}`, padding: "36px 28px", margin: "-0.75px" }}>
            <span style={{ fontFamily: mono, fontSize: 9, textTransform: "uppercase", letterSpacing: 2, color: t.muted }}>Starter</span>
            <div style={{ fontSize: 48, fontWeight: 900, letterSpacing: -3, margin: "8px 0 12px" }}>FREE</div>
            <p style={{ fontSize: 13, color: t.muted, lineHeight: 1.55, marginBottom: 24 }}>For DJs getting started.</p>
            <button style={{
              fontFamily: mono, fontSize: 10, width: "100%", padding: "12px 0",
              background: "transparent", color: t.text, border: `1.5px solid ${t.accentSoft}`,
              textTransform: "uppercase", letterSpacing: 1.5, cursor: "pointer", transition: "all 0.2s",
            }}
              onMouseEnter={e => e.target.style.borderColor = t.accent}
              onMouseLeave={e => e.target.style.borderColor = t.accentSoft}
            >Get started</button>
            <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 8 }}>
              {["500 tracks", "Basic tagging", "3 crates", "Rekordbox export"].map(f => (
                <span key={f} style={{ fontFamily: mono, fontSize: 10, color: t.muted, letterSpacing: 0.5 }}>— {f}</span>
              ))}
            </div>
          </div>
          {/* Pro */}
          <div style={{ border: `1.5px solid ${t.accentSoft}`, padding: "36px 28px", margin: "-0.75px", background: t.proBg, color: t.proText }}>
            <span style={{ fontFamily: mono, fontSize: 9, textTransform: "uppercase", letterSpacing: 2, color: t.muted }}>Pro</span>
            <div style={{ fontSize: 48, fontWeight: 900, letterSpacing: -3, margin: "8px 0 4px" }}>
              €79<span style={{ fontSize: 14, fontWeight: 400, color: t.muted }}>/yr</span>
            </div>
            <p style={{ fontSize: 13, color: t.muted, lineHeight: 1.55, marginBottom: 24 }}>Full access. Everything.</p>
            <button style={{
              fontFamily: mono, fontSize: 10, width: "100%", padding: "12px 0",
              background: t.proBtn, color: t.proBtnText, border: "none",
              textTransform: "uppercase", letterSpacing: 1.5, cursor: "pointer", transition: "opacity 0.2s",
            }} onMouseEnter={e => e.target.style.opacity = 0.85} onMouseLeave={e => e.target.style.opacity = 1}>Start trial →</button>
            <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 8 }}>
              {["Unlimited tracks", "Chapter Builder", "Graph Playlists", "Scatter Map", "All exports", "Cloud sync"].map(f => (
                <span key={f} style={{ fontFamily: mono, fontSize: 10, color: t.muted, letterSpacing: 0.5 }}>— {f}</span>
              ))}
            </div>
          </div>
        </Fade>
        <Fade delay={100}>
          <p style={{ fontFamily: mono, fontSize: 10, color: t.muted, marginTop: 16, letterSpacing: 1 }}>30-day full refund. No questions asked.</p>
        </Fade>
      </section>

      {/* ═══ CTA ═══ */}
      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "80px 32px 120px" }}>
        <Fade>
          <div style={{ borderTop: `1.5px solid ${t.accentSoft}`, paddingTop: 48, display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 48, alignItems: "end" }}>
            <Parallax speed={-0.04}>
              <h2 style={{ fontSize: "clamp(40px, 5.5vw, 72px)", fontWeight: 900, lineHeight: 0.92, letterSpacing: -2.5 }}>
                <GlitchText t={t}>READY TO</GlitchText><br />DROP THE<br />NEEDLE?
              </h2>
            </Parallax>
            <div>
              <p style={{ fontSize: 15, color: t.muted, lineHeight: 1.6, marginBottom: 28 }}>
                Free to start. No credit card. Join DJs who prep smarter.
              </p>
              <button style={{
                fontFamily: mono, fontSize: 12, background: t.accent, color: t.bg,
                border: `2px solid ${t.accent}`, padding: "14px 36px", cursor: "pointer",
                textTransform: "uppercase", letterSpacing: 2, transition: "all 0.2s",
              }}
                onMouseEnter={e => { e.target.style.background = "transparent"; e.target.style.color = t.accent; }}
                onMouseLeave={e => { e.target.style.background = t.accent; e.target.style.color = t.bg; }}
              >Get started free →</button>
            </div>
          </div>
        </Fade>
      </section>

      {/* ═══ FOOTER ═══ */}
      <footer style={{ maxWidth: 1200, margin: "0 auto", padding: "0 32px 40px" }}>
        <div style={{ borderTop: `1.5px solid ${t.accentSoft}`, paddingTop: 32, display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 1fr", gap: 32 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <Logo color={t.text} w={22} h={16} />
              <span style={{ fontFamily: mono, fontWeight: 700, fontSize: 12 }}>DJToolKit</span>
            </div>
            <p style={{ fontFamily: mono, fontSize: 10, color: t.muted, letterSpacing: 1 }}>Sync. Organize. Play.</p>
          </div>
          {[
            { ti: "Features", l: ["Chapters", "Graph", "Scatter", "Tagging"] },
            { ti: "Company", l: ["About", "Blog", "Careers"] },
            { ti: "Legal", l: ["Privacy", "Terms", "Imprint"] },
          ].map(col => (
            <div key={col.ti}>
              <span style={{ fontFamily: mono, fontSize: 9, textTransform: "uppercase", letterSpacing: 2, color: t.muted, display: "block", marginBottom: 12 }}>{col.ti}</span>
              {col.l.map(l => (
                <a key={l} href="#" style={{ fontFamily: mono, display: "block", fontSize: 11, color: t.text, textDecoration: "none", marginBottom: 8, opacity: 0.5, transition: "opacity 0.2s" }}
                  onMouseEnter={e => e.target.style.opacity = 1} onMouseLeave={e => e.target.style.opacity = 0.5}>{l}</a>
              ))}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 32, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: mono, fontSize: 10, color: t.muted }}>© 2026 DJToolKit</span>
          <div style={{ display: "flex", gap: 16 }}>
            {["IG", "LI", "YT"].map(s => (
              <a key={s} href="#" style={{ fontFamily: mono, fontSize: 10, color: t.muted, textDecoration: "none", transition: "color 0.2s" }}
                onMouseEnter={e => e.target.style.color = t.text} onMouseLeave={e => e.target.style.color = t.muted}>{s}</a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
