import { cn } from "@/lib/cn";

const statusMap = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
  info: "bg-info",
  off: "bg-muted-foreground/40",
} as const;

export type StatusDotStatus = keyof typeof statusMap;

interface StatusDotProps {
  status: StatusDotStatus;
  /** Pulse for in-progress states (busy downloads, active listening). */
  pulse?: boolean;
  className?: string;
}

/**
 * The one status indicator dot (online/busy/error/off). Replaces hand-rolled,
 * ad hoc colored dot spans so status hues stay on the semantic tokens.
 */
export function StatusDot({ status, pulse, className }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        statusMap[status],
        pulse && "animate-pulse",
        className,
      )}
    />
  );
}
