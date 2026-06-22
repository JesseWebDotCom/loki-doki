import { Fragment } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";
import { ChromeWash } from "./ChromeWash";
import type { LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

export interface BreadcrumbCrumb {
  label: string;
  /** Renders as a Link when set; otherwise as plain text. */
  href?: string;
  icon?: LucideIcon;
  iconStyle?: CSSProperties;
  /** Custom node that overrides icon+iconStyle (e.g. a gradient archive tile). */
  iconNode?: ReactNode;
  /** Truncates long labels with an ellipsis (e.g. conversation titles). */
  truncate?: boolean;
}

interface AppBreadcrumbProps {
  crumbs: BreadcrumbCrumb[];
  /** Right-side slot: nav buttons, search bar, etc. */
  children?: ReactNode;
  className?: string;
}

export function AppBreadcrumb({ crumbs, children, className }: AppBreadcrumbProps) {
  return (
    <div
      className={cn(
        "relative shrink-0 flex h-12 items-center gap-1.5 border-b border-border/40 bg-background/70 px-4 backdrop-blur-md",
        className,
      )}
    >
      <ChromeWash />
      {crumbs.map((crumb, i) => {
        const Icon = crumb.icon;
        const iconEl = crumb.iconNode ?? (Icon
          ? <Icon className="size-3.5 shrink-0" style={crumb.iconStyle} />
          : null
        );
        const isCurrent = !crumb.href && i === crumbs.length - 1;
        const labelEl = crumb.truncate
          ? <span className="truncate max-w-[14rem]">{crumb.label}</span>
          : crumb.label;

        return (
          <Fragment key={i}>
            {i > 0 && (
              <span className="text-muted-foreground/40 text-xs select-none shrink-0">/</span>
            )}
            {crumb.href ? (
              <Link
                to={crumb.href}
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                {iconEl}
                {labelEl}
              </Link>
            ) : isCurrent ? (
              <span className="flex items-center gap-1 text-sm font-medium shrink-0 min-w-0">
                {iconEl}
                {labelEl}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-sm text-muted-foreground shrink-0">
                {iconEl}
                {labelEl}
              </span>
            )}
          </Fragment>
        );
      })}

      {children && (
        <>
          <div className="h-4 w-px bg-border/40 mx-1 shrink-0" />
          <div className="flex flex-1 items-center gap-2 min-w-0">
            {children}
          </div>
        </>
      )}
    </div>
  );
}
