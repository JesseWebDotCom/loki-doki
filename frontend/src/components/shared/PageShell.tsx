import { useLocation } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { getAppByPath } from "@/lib/appCategories";
import { classifyRoute } from "@/lib/routeChrome";
import { AppBackdrop } from "./AppBackdrop";

interface PageShellProps {
  gradient?: string;
  GhostIcon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}

/**
 * Transparent page wrapper that carries the app's color identity (corner-fade tint +
 * ghost-icon watermark). For standard scroller apps the AppShell already paints this
 * backdrop, so PageShell stays a transparent pass-through there and only self-tints on
 * full-bleed / chat routes that the shell does not cover. Existing pages can keep
 * wrapping in PageShell unchanged — the tint is applied exactly once either way.
 */
export function PageShell({ gradient, GhostIcon, children, className }: PageShellProps) {
  const { pathname } = useLocation();
  const { shellBackdrop } = classifyRoute(pathname);

  const app = !gradient ? getAppByPath(pathname) : undefined;
  const resolvedGradient = gradient ?? app?.gradient ?? "";
  const ResolvedIcon = GhostIcon ?? app?.icon;

  return (
    <div className={cn("relative min-h-full flex flex-col", className)}>
      {/* Shell already owns the backdrop for standard scroller apps — don't double-paint. */}
      {!shellBackdrop && <AppBackdrop gradient={resolvedGradient} GhostIcon={ResolvedIcon} />}
      <div className="relative z-10 flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}
