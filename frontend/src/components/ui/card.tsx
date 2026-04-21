import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Shadcn-style Card primitive.
 *
 * Reused by the block renderers in ``components/chat/blocks/`` to get a
 * consistent Onyx Material Level 1/2 container without each block
 * reinventing padding + border + shadow. Kept intentionally minimal —
 * we only surface the pieces the first consumers (``BlockShell`` and
 * future block types) need.
 */

function Card({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "rounded-2xl border border-border/40 bg-card text-card-foreground shadow-m1",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  );
}

function CardContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("p-4 pt-0", className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardContent };
