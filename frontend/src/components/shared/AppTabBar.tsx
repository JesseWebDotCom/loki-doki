import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export interface AppTab<T extends string = string> {
  id: T;
  label: string;
  icon?: LucideIcon;
  /** Shorter label for narrow screens. Defaults to the first word of `label`. */
  shortLabel?: string;
}

interface AppTabBarProps<T extends string> {
  tabs: AppTab<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  /** 'glass' = white/10 pill over a dark image/video backdrop (video watch page, Now
   *  Playing overlay) with an always-white active state, independent of the app theme.
   *  Default renders with the normal semantic card tokens. */
  variant?: "default" | "glass";
  /** Inactive tabs collapse to icon-only, full label reappears once selected — for
   *  columns too narrow to fit every tab's full label (the video watch page's sticky
   *  400px side rail). Requires every tab to carry an `icon`. */
  compact?: boolean;
}

/**
 * The standardized in-body sub-navigation pill row for tabbed apps (Music, Videos,
 * Podcasts, ...). Use this instead of hand-rolling a tab row so every tabbed app looks
 * and behaves identically — including the two shape variants real surfaces need
 * (`variant` for backdrop, `compact` for narrow columns), rather than a fork per page.
 */
export function AppTabBar<T extends string>({ tabs, value, onChange, className, variant = "default", compact = false }: AppTabBarProps<T>) {
  const glass = variant === "glass";
  return (
    <div className={cn("no-scrollbar overflow-x-auto", className)}>
      <div className={cn("flex w-fit max-w-full rounded-full p-1", glass ? "gap-1 bg-white/10" : "gap-0.5 border border-border/50 bg-muted/30")}>
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = value === t.id;
          const short = t.shortLabel ?? t.label.split(" ")[0];
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              title={t.label}
              aria-label={t.label}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full text-sm font-semibold transition-colors",
                compact ? (isActive ? "py-1.5 pl-2.5 pr-3.5" : "py-1.5 px-2.5") : "px-3 py-2",
                glass
                  ? isActive ? "bg-white text-black" : "text-white/70 hover:text-white"
                  : isActive ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {Icon && <Icon className="size-4 shrink-0" />}
              {compact ? (
                (isActive || !Icon) && <span>{t.label}</span>
              ) : (
                <>
                  <span className="hidden sm:inline">{t.label}</span>
                  <span className="sm:hidden">{short}</span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
