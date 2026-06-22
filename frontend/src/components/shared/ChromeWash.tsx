import { cn } from "@/lib/cn";

/**
 * Faint violet wash for chrome bars — the brand glow shared across the
 * boot screen, setup wizard, sidebar, and breadcrumb. Drop it in as the
 * first child of a `relative` bar; it's `pointer-events-none` so it never
 * intercepts clicks. Pair with `bg-background/70 backdrop-blur-md` for the
 * full canonical chrome finish.
 */
export function ChromeWash({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 bg-gradient-to-r from-violet-600/[0.06] via-transparent to-transparent",
        className,
      )}
    />
  );
}
