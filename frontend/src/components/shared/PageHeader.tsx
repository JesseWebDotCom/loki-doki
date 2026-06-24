import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

interface PageHeaderPlainProps {
  variant?: "plain";
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
}

interface PageHeaderHeroProps {
  variant: "hero";
  eyebrow?: string;
  title: string;
  subtitle?: string;
  gradient: string;
  icon?: React.ReactNode;
  GhostIcon?: LucideIcon;
  cta?: React.ReactNode;
  className?: string;
}

interface PageHeaderCompactProps {
  variant: "compact";
  eyebrow?: string;
  title: string;
  subtitle?: string;
  gradient: string;
  icon?: React.ReactNode;
  GhostIcon?: LucideIcon;
  actions?: React.ReactNode;
  className?: string;
}

type PageHeaderProps = PageHeaderPlainProps | PageHeaderHeroProps | PageHeaderCompactProps;

export function PageHeader(props: PageHeaderProps) {
  if (props.variant === "compact") {
    const { eyebrow, title, subtitle, gradient, icon, GhostIcon, actions, className } = props;
    return (
      <div className={cn("relative pb-4", className)}>
        {GhostIcon && (
          <GhostIcon className="pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 size-20 rotate-[-10deg] text-white/10 z-0" />
        )}
        <div className="relative z-10 flex items-center gap-3 px-5 py-3">
          {icon && (
            <div
              className="flex size-14 shrink-0 items-center justify-center rounded-2xl shadow-sm ring-1 ring-white/10"
              style={{ background: gradient }}
            >
              {icon}
            </div>
          )}
          <div className="min-w-0 flex-1">
            {eyebrow && (
              <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-white/50 leading-none">
                {eyebrow}
              </p>
            )}
            <h1 className={cn("font-black tracking-tight text-white leading-tight", eyebrow ? "mt-0.5 text-4xl" : "text-4xl")}>
              {title}
            </h1>
            {subtitle && (
              <p className="mt-1 text-sm leading-tight text-white/60">{subtitle}</p>
            )}
          </div>
          {actions && (
            <div className="ml-auto shrink-0">{actions}</div>
          )}
        </div>
      </div>
    );
  }

  if (props.variant === "hero") {
    const { eyebrow, title, subtitle, gradient, icon, GhostIcon, cta, className } = props;
    return (
      <div className={cn("mx-4 sm:mx-5", className)}>
        <div
          className="relative overflow-hidden rounded-3xl px-6 pt-8 pb-6"
          style={{ background: gradient }}
        >
          <div className="pointer-events-none absolute -bottom-20 -right-20 size-64 rounded-full bg-white/5 blur-3xl" />
          <div className="pointer-events-none absolute -top-12 -left-12 size-44 rounded-full bg-white/5 blur-3xl" />
          {GhostIcon && (
            <GhostIcon className="pointer-events-none absolute -bottom-4 -right-3 size-[100px] rotate-[-20deg] text-white/20" />
          )}
          {icon && (
            <div className="relative z-10 mb-4 flex size-12 items-center justify-center rounded-2xl bg-white/15 backdrop-blur-sm ring-1 ring-white/20">
              {icon}
            </div>
          )}
          {eyebrow && (
            <p className="relative z-10 text-[10px] font-bold uppercase tracking-[0.25em] text-white/50">
              {eyebrow}
            </p>
          )}
          <h1
            className={cn(
              "relative z-10 font-black tracking-tight text-white",
              eyebrow ? "mt-2 text-3xl sm:text-4xl" : "text-3xl sm:text-4xl",
            )}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="relative z-10 mt-1.5 max-w-sm text-sm leading-relaxed text-white/60">
              {subtitle}
            </p>
          )}
          {cta && <div className="relative z-10 mt-5">{cta}</div>}
        </div>
      </div>
    );
  }

  const { eyebrow, title, subtitle, actions, className } = props;
  return (
    <div className={cn("flex items-end justify-between px-5 pt-10 pb-6", className)}>
      <div className="min-w-0 flex-1">
        {eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {eyebrow}
          </p>
        )}
        <h1
          className={cn(
            "font-black tracking-tight",
            eyebrow ? "mt-1 text-3xl sm:text-4xl" : "text-3xl sm:text-4xl",
          )}
        >
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="ml-4 flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
