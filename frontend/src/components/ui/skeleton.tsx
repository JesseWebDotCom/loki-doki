import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Shadcn-style Skeleton primitive.
 *
 * Used by block renderers for the ``loading`` / ``partial`` states.
 * Pulses via Tailwind's built-in ``animate-pulse``; no new dependency.
 */
function Skeleton({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted/60", className)}
      {...props}
    />
  );
}

export { Skeleton };
