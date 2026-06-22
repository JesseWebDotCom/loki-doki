import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";

interface SectionHeaderProps {
  title: string;
  to?: string;
  /** Optional leading element (icon tile, emoji, etc.) */
  lead?: React.ReactNode;
  className?: string;
}

export function SectionHeader({ title, to, lead, className }: SectionHeaderProps) {
  const heading = (
    <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight">
      {lead}
      {title}
    </h2>
  );

  return (
    <div className={cn("flex items-center justify-between", className)}>
      {to ? (
        <Link to={to} className="group flex items-center gap-2 text-lg font-bold tracking-tight hover:underline underline-offset-4">
          {lead}
          {title}
        </Link>
      ) : heading}
      {to && (
        <Link
          to={to}
          className="flex items-center gap-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          See all <ChevronRight className="size-3.5" />
        </Link>
      )}
    </div>
  );
}
