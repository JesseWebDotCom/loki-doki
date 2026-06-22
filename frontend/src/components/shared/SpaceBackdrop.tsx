import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";

// A deep-space backdrop: twinkling starfield, occasional shooting stars, and a
// slowly drifting UFO. Meant to sit behind a transparent globe/planet canvas
// (Maps globe view, Moon phase app). Purely decorative — never captures input.

interface Star {
  top: number; // %
  left: number; // %
  size: number; // px
  duration: number; // s (twinkle)
  delay: number; // s (negative — start mid-cycle)
}

interface Shooter {
  top: number; // %
  left: number; // %
  duration: number; // s
  delay: number; // s
}

function buildStars(count: number): Star[] {
  return Array.from({ length: count }, () => ({
    top: Math.random() * 100,
    left: Math.random() * 100,
    size: Math.random() < 0.9 ? 0.8 + Math.random() * 1.1 : 1.9 + Math.random() * 1.1,
    // Slower, gentler twinkle.
    duration: 4 + Math.random() * 6,
    delay: -Math.random() * 9,
  }));
}

function buildShooters(count: number): Shooter[] {
  return Array.from({ length: count }, (_, i) => ({
    top: 5 + Math.random() * 32,
    left: 52 + Math.random() * 42,
    // Long, staggered cycles so a streak appears only every ~20-40s, not a storm.
    duration: 22 + Math.random() * 16,
    delay: -(i * 11 + Math.random() * 9),
  }));
}

export function SpaceBackdrop({
  starCount = 90,
  shootingStars = true,
  ufo = true,
  className,
}: {
  starCount?: number;
  shootingStars?: boolean;
  ufo?: boolean;
  className?: string;
}): JSX.Element {
  const stars = useMemo(() => buildStars(starCount), [starCount]);
  const shooters = useMemo(() => (shootingStars ? buildShooters(3) : []), [shootingStars]);

  // Gentle fade-in on mount so the scene doesn't pop.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-700",
        shown ? "opacity-100" : "opacity-0",
        className,
      )}
      style={{
        background:
          "radial-gradient(120% 90% at 50% 40%, #0b1026 0%, #070a18 45%, #02030a 100%)",
      }}
    >
      {stars.map((s, i) => (
        <span
          key={`star-${i}`}
          style={{
            position: "absolute",
            top: `${s.top}%`,
            left: `${s.left}%`,
            width: `${s.size}px`,
            height: `${s.size}px`,
            borderRadius: "9999px",
            background: "rgba(214, 230, 250, 0.7)",
            animation: `star-twinkle ${s.duration}s ease-in-out ${s.delay}s infinite`,
          }}
        />
      ))}

      {shooters.map((sh, i) => (
        <span
          key={`shoot-${i}`}
          className="space-shooting-star"
          style={{
            top: `${sh.top}%`,
            left: `${sh.left}%`,
            animationDuration: `${sh.duration}s`,
            animationDelay: `${sh.delay}s`,
          }}
        />
      ))}

      {ufo ? (
        <div className="space-ufo" style={{ top: "20%", left: "-90px", animationDuration: "95s" }}>
          <svg width="64" height="34" viewBox="0 0 64 34" fill="none" xmlns="http://www.w3.org/2000/svg">
            {/* glow */}
            <ellipse cx="32" cy="22" rx="30" ry="9" fill="rgba(125, 211, 252, 0.18)" />
            {/* dome */}
            <path d="M20 17 a12 9 0 0 1 24 0 Z" fill="#cbd5e1" />
            <path d="M24 16 a8 6 0 0 1 16 0 Z" fill="#7dd3fc" opacity="0.85" />
            {/* saucer body */}
            <ellipse cx="32" cy="19" rx="26" ry="7" fill="#94a3b8" />
            <ellipse cx="32" cy="18" rx="26" ry="6" fill="#cbd5e1" />
            {/* under-lights */}
            <circle cx="18" cy="20" r="1.6" fill="#fde047" />
            <circle cx="26" cy="22" r="1.6" fill="#34d399" />
            <circle cx="32" cy="22.5" r="1.6" fill="#f472b6" />
            <circle cx="38" cy="22" r="1.6" fill="#34d399" />
            <circle cx="46" cy="20" r="1.6" fill="#fde047" />
          </svg>
        </div>
      ) : null}
    </div>
  );
}
