import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export interface StatTileProps {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
  /** Small trend/delta chip rendered next to the value. */
  delta?: React.ReactNode;
  caption?: string;
  /** Renders the tile as a link when set. */
  to?: string;
  className?: string;
}

/**
 * The one stat/KPI tile: overline label, big tabular number, optional caption.
 * Tier-1 resting card; gains the interactive hover treatment when `to` is set.
 */
export function StatTile({ label, value, icon: Icon, delta, caption, to, className }: StatTileProps) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-overline text-muted-foreground truncate">{label}</p>
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
        {delta}
      </div>
      {caption && <p className="mt-1 text-caption text-muted-foreground truncate">{caption}</p>}
    </>
  );

  const base = "block rounded-card border border-border bg-card p-4";
  if (to) {
    return (
      <Link
        to={to}
        className={cn(
          base,
          "transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md active:scale-[0.99]",
          className,
        )}
      >
        {body}
      </Link>
    );
  }
  return <div className={cn(base, className)}>{body}</div>;
}
