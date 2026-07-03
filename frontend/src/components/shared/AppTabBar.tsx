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
}

/**
 * The standardized in-body sub-navigation pill row for tabbed apps (Music, etc.).
 * Sits just under the breadcrumb, inside the page body. Use this instead of
 * hand-rolling a tab row so every tabbed app looks identical.
 */
export function AppTabBar<T extends string>({ tabs, value, onChange, className }: AppTabBarProps<T>) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <div className="flex gap-0.5 rounded-full border border-border/50 bg-muted/30 p-1">
        {tabs.map((t) => {
          const Icon = t.icon;
          const short = t.shortLabel ?? t.label.split(" ")[0];
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-sm font-semibold transition-all",
                value === t.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {Icon && <Icon className="size-4" />}
              <span className="hidden sm:inline">{t.label}</span>
              <span className="sm:hidden">{short}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
