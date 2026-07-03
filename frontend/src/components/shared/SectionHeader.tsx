import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";

interface SectionHeaderProps {
  title: string;
  to?: string;
  /** Optional leading element (icon tile, etc.) */
  lead?: React.ReactNode;
  /** Item count rendered after the title. */
  count?: number;
  className?: string;
}

/**
 * The one section heading. Spacing contract between sections: `mt-10 mb-4`
 * (apply on the wrapper via className).
 */
export function SectionHeader({ title, to, lead, count, className }: SectionHeaderProps) {
  const inner = (
    <>
      {lead}
      {title}
      {count !== undefined && (
        <span className="text-caption text-muted-foreground tabular-nums">{count}</span>
      )}
    </>
  );

  return (
    <div className={cn("flex items-center justify-between", className)}>
      {to ? (
        <Link to={to} className="group flex items-center gap-2 text-section hover:underline underline-offset-4">
          {inner}
        </Link>
      ) : (
        <h2 className="flex items-center gap-2 text-section">{inner}</h2>
      )}
      {to && (
        <Link
          to={to}
          className="flex items-center gap-0.5 text-sm font-medium text-brand transition-colors hover:text-brand-hover"
        >
          See all <ChevronRight className="size-3.5" />
        </Link>
      )}
    </div>
  );
}
