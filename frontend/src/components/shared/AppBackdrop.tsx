import type { LucideIcon } from "lucide-react";

// Brighten the app's first gradient stop so it reads as a visible tint on a dark
// background, then fade it diagonally from the top-left. Shared by AppShell (which
// paints standard scroller apps) and PageShell (full-bleed / chat pages).
function toCornerFade(gradient: string, alpha: number): string {
  const match = gradient.match(/#([0-9a-fA-F]{6})/);
  if (!match) return "";
  const h = match[1];
  const r = Math.min(255, parseInt(h.slice(0, 2), 16) * 3);
  const g = Math.min(255, parseInt(h.slice(2, 4), 16) * 3);
  const b = Math.min(255, parseInt(h.slice(4, 6), 16) * 3);
  return `linear-gradient(to bottom right, rgba(${r},${g},${b},${alpha}) 0%, transparent 55%)`;
}

interface AppBackdropProps {
  /** App gradient (e.g. registry `app.gradient`). Only the first hex stop is used for the tint. */
  gradient?: string;
  /** Ghost watermark icon in the lower-right. */
  GhostIcon?: LucideIcon;
}

/**
 * The app color identity layer: a corner-fade tint + a faint ghost-icon watermark.
 * Render it as an `absolute inset-0` sibling BEHIND `relative z-10` page content.
 * Purely decorative — never captures input.
 */
export function AppBackdrop({ gradient, GhostIcon }: AppBackdropProps) {
  const fade = gradient ? toCornerFade(gradient, 0.28) : "";
  return (
    <>
      {fade && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0"
          style={{ background: fade }}
        />
      )}
      {GhostIcon && (
        <GhostIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-[55vh] right-10 size-64 rotate-[-10deg] text-white opacity-[0.06] z-0"
        />
      )}
    </>
  );
}
