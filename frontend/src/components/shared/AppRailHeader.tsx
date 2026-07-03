import { useLocation } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { getAppByPath } from "@/lib/appCategories";

interface AppRailHeaderProps {
  title: string;
  /** Defaults to the current app's short registry description (use for routes not in APP_GROUPS). */
  description?: string;
  /** Defaults to the current app's registry icon (use for routes not in APP_GROUPS). */
  icon?: LucideIcon;
  /** Defaults to the current app's registry gradient. */
  gradient?: string;
  className?: string;
}

/**
 * The standardized app-identity header for layout apps with a left rail (YouTube,
 * Bookmarks, Podcasts, Companions, App Store). Renders the app's registry icon in its
 * registry gradient tile so it matches the breadcrumb tile and the rest of the app's
 * color identity. Never hand-roll this tile with a hardcoded color again.
 */
export function AppRailHeader({ title, description, icon, gradient, className }: AppRailHeaderProps) {
  const { pathname } = useLocation();
  const app = getAppByPath(pathname);
  const Icon = icon ?? app?.icon;
  const grad = gradient ?? app?.gradient;
  const desc = description ?? app?.description;
  return (
    <div className={cn("flex items-start gap-2.5 px-2", className)}>
      {Icon && (
        <span
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control text-white shadow-sm"
          style={grad ? { background: grad } : undefined}
        >
          <Icon className="size-4" />
        </span>
      )}
      <div>
        <p className="text-base font-semibold leading-tight tracking-tight">{title}</p>
        {desc && <p className="text-[11px] leading-snug text-muted-foreground">{desc}</p>}
      </div>
    </div>
  );
}
