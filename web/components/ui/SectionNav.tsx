"use client";

interface SectionNavItem {
  id: string;
  label: string;
}

interface SectionNavProps {
  sections: SectionNavItem[];
  activeId: string;
  onSelect: (id: string) => void;
}

export default function SectionNav({ sections, activeId, onSelect }: SectionNavProps) {
  return (
    <nav className="sticky top-0 pt-3">
      {sections.map((s) => {
        const isActive = activeId === s.id;
        return (
          <a
            key={s.id}
            href={`#${s.id}`}
            onClick={(e) => {
              e.preventDefault();
              onSelect(s.id);
              document
                .getElementById(s.id)
                ?.scrollIntoView({ behavior: "smooth" });
            }}
            className="block font-mono transition-all duration-150"
            style={{
              fontSize: 11,
              fontWeight: isActive ? 700 : 400,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              color: isActive ? "var(--led-blue)" : "var(--hw-text-dim)",
              padding: "6px 14px",
              borderLeft: `2px solid ${isActive ? "var(--led-blue)" : "transparent"}`,
              textDecoration: "none",
            }}
          >
            {s.label}
          </a>
        );
      })}
    </nav>
  );
}
