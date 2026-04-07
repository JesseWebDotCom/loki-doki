import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * shadcn-style classname helper. Re-exported here so components can do
 * `import { cn } from "@/lib/utils"` without each one wiring up clsx +
 * tailwind-merge themselves.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a millisecond duration for the sidebar / pipeline UI. The UI
 * shows latencies all over the place; we keep the formatting in one
 * place so a sub-second value never accidentally renders as "0ms" or
 * "1.234s" depending on the call site.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(2)}s`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = Math.round(seconds - minutes * 60);
  return `${minutes}m${remSec}s`;
}
