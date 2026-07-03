import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

const sizeMap = {
  sm: "size-3.5",
  default: "size-4",
  lg: "size-6",
} as const;

interface SpinnerProps {
  size?: keyof typeof sizeMap;
  className?: string;
}

/**
 * The one inline loading spinner. Use for in-flight buttons and small async
 * affordances; region/page loading uses Skeleton compositions instead
 * (see shared/SkeletonBlocks).
 */
export function Spinner({ size = "default", className }: SpinnerProps) {
  return (
    <Loader2
      aria-hidden="true"
      className={cn("animate-spin text-muted-foreground", sizeMap[size], className)}
    />
  );
}
