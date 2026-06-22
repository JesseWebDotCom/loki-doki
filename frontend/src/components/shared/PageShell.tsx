import { useRef } from "react";
import { useLocation } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { getAppByPath } from "@/lib/appCategories";

function toCornerFade(gradient: string, alpha: number): string {
  const match = gradient.match(/#([0-9a-fA-F]{6})/);
  if (!match) return "";
  const h = match[1];
  // Brighten dark app colors so they read as a visible tint on a dark background
  const r = Math.min(255, parseInt(h.slice(0, 2), 16) * 3);
  const g = Math.min(255, parseInt(h.slice(2, 4), 16) * 3);
  const b = Math.min(255, parseInt(h.slice(4, 6), 16) * 3);
  // Brightest at top-left, fades diagonally down-right, gone by ~50% of diagonal
  return `linear-gradient(to bottom right, rgba(${r},${g},${b},${alpha}) 0%, transparent 55%)`;
}

interface PageShellProps {
  gradient?: string;
  GhostIcon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}

export function PageShell({ gradient, GhostIcon, children, className }: PageShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();

  const app = !gradient ? getAppByPath(pathname) : undefined;
  const resolvedGradient = gradient ?? app?.gradient ?? "";
  const ResolvedIcon = GhostIcon ?? app?.icon;

  return (
    <div ref={rootRef} className={cn("relative min-h-full flex flex-col", className)}>
      {resolvedGradient && (
        <div
          className="pointer-events-none absolute inset-0 z-0"
          style={{ background: toCornerFade(resolvedGradient, 0.28) }}
        />
      )}
      {ResolvedIcon && (
        <ResolvedIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-[55vh] right-10 size-64 rotate-[-10deg] text-white opacity-[0.06] z-0"
        />
      )}
      <div className="relative z-10 flex-1 min-h-0 flex flex-col">
        {children}
      </div>
    </div>
  );
}
