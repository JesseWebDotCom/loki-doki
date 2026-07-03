import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";

export interface ListRowProps {
  /** Media/icon slot; sized by the caller (convention: size-10 rounded-control overflow-hidden). */
  leading?: React.ReactNode;
  title: string;
  meta?: string;
  /** Duration, action buttons, or a chevron. */
  trailing?: React.ReactNode;
  to?: string;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
}

/**
 * The one precise list row (track lists, news items, settings rows).
 * Rows sit either bare in a stack or inside a Card with
 * `divide-y divide-border/50` on the parent.
 */
export function ListRow({ leading, title, meta, trailing, to, onClick, selected, className }: ListRowProps) {
  const inner = (
    <>
      {leading && <span className="shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm font-medium", selected && "text-brand")}>{title}</span>
        {meta && <span className="block truncate text-caption text-muted-foreground">{meta}</span>}
      </span>
      {trailing && <span className="shrink-0 flex items-center gap-1.5">{trailing}</span>}
    </>
  );

  const rowCls = cn(
    "flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left transition-colors",
    selected ? "bg-brand/10" : "hover:bg-foreground/[0.04] active:bg-foreground/[0.07]",
    className,
  );

  if (to) {
    return (
      <Link to={to} onClick={onClick} className={rowCls}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={rowCls}>
        {inner}
      </button>
    );
  }
  return <div className={rowCls}>{inner}</div>;
}
