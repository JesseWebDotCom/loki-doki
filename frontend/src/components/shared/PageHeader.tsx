import { useLocation } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { getAppByPath, getGroupByAppPath } from "@/lib/appCategories";

interface PageHeaderProps {
  /** Defaults to the registry app label for the current route. */
  title?: string;
  subtitle?: string;
  /** Defaults to the registry app-group name. Rendered as an overline. */
  eyebrow?: string;
  actions?: React.ReactNode;
  /** Editorial hero panel (app landing pages) instead of the standard header row. */
  hero?: boolean;
  /** Bare display title (Apple-Music style): no identity tile, no eyebrow, larger type.
   *  For media apps whose pages lead with content, not app identity. */
  plain?: boolean;
  /** CTA row, hero only. */
  cta?: React.ReactNode;
  /** Override for pages not in the app registry (category pages, settings shells). */
  icon?: LucideIcon;
  /** Override for pages not in the app registry. */
  gradient?: string;
  className?: string;
}

/** First hex stop of a registry gradient, for the hero's soft radial glow. */
function firstStop(gradient: string): string | null {
  const match = gradient.match(/#[0-9a-fA-F]{6}/);
  return match ? match[0] : null;
}

/**
 * The one page header. Auto-resolves title, eyebrow, icon, and gradient from
 * the app registry (`appCategories`) so most pages pass nothing but a subtitle.
 * The identity tile here is the page's single big app-gradient moment; the
 * title style (`text-display`) is the only sanctioned h1 in the app.
 */
export function PageHeader(props: PageHeaderProps) {
  const { pathname } = useLocation();
  const app = getAppByPath(pathname);
  const group = getGroupByAppPath(pathname);

  const title = props.title ?? app?.label ?? "";
  const eyebrow = props.eyebrow ?? (props.title === undefined ? group?.name : undefined);
  const Icon = props.icon ?? app?.icon;
  const gradient = props.gradient ?? app?.gradient;

  const identityTile = Icon && gradient && (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-card shadow-sm ring-1 ring-white/10",
        props.hero ? "size-14" : "size-12",
      )}
      style={{ background: gradient }}
    >
      <Icon className={cn("text-white", props.hero ? "size-7" : "size-6")} aria-hidden="true" />
    </div>
  );

  if (props.plain) {
    return (
      <div className={cn("flex items-end justify-between gap-4 pt-7 pb-5", props.className)}>
        <div className="min-w-0">
          <h1 className="truncate text-display-lg font-extrabold tracking-tight text-foreground">{title}</h1>
          {props.subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{props.subtitle}</p>}
        </div>
        {props.actions && <div className="flex shrink-0 items-center gap-2">{props.actions}</div>}
      </div>
    );
  }

  if (props.hero) {
    const glowStop = gradient ? firstStop(gradient) : null;
    return (
      <div
        className={cn(
          "relative overflow-hidden rounded-sheet border border-border bg-card px-6 pt-9 pb-7 sm:px-8",
          props.className,
        )}
      >
        {/* App identity as atmosphere: a soft radial glow of the app hue, not a paint-bucket fill. */}
        {glowStop && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{ background: `radial-gradient(640px circle at 0% 0%, ${glowStop}2e, transparent 62%)` }}
          />
        )}
        {Icon && (
          <Icon
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-5 -right-4 size-32 rotate-[-14deg] text-foreground opacity-[0.05]"
          />
        )}
        <div className="relative flex items-start justify-between gap-4">
          <div className="min-w-0">
            {identityTile && <div className="mb-5">{identityTile}</div>}
            {eyebrow && <p className="text-overline text-muted-foreground">{eyebrow}</p>}
            <h1 className={cn("text-display sm:text-display-lg text-foreground", eyebrow && "mt-2")}>
              {title}
            </h1>
            {props.subtitle && (
              <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">{props.subtitle}</p>
            )}
            {props.cta && <div className="mt-6 flex items-center gap-2">{props.cta}</div>}
          </div>
          {props.actions && <div className="shrink-0 flex items-center gap-2">{props.actions}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex items-end justify-between gap-4 pt-8 pb-6", props.className)}>
      <div className="flex min-w-0 items-center gap-4">
        {identityTile}
        <div className="min-w-0">
          {eyebrow && <p className="text-overline text-muted-foreground">{eyebrow}</p>}
          <h1 className={cn("truncate text-display text-foreground", eyebrow && "mt-1.5")}>{title}</h1>
          {props.subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{props.subtitle}</p>}
        </div>
      </div>
      {props.actions && <div className="flex shrink-0 items-center gap-2">{props.actions}</div>}
    </div>
  );
}
