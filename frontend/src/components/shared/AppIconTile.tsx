import { cn } from "@/lib/cn";
import type { LucideIcon } from "lucide-react";

interface AppIconTileProps {
  icon: LucideIcon;
  gradient: string;
  /** "sm" = size-5 container / size-3.5 icon (sidebar, breadcrumb).
   *  "md" = size-7 container / size-4 icon (larger contexts). */
  size?: "sm" | "md";
  className?: string;
}

export function AppIconTile({ icon: Icon, gradient, size = "sm", className }: AppIconTileProps) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md",
        size === "sm" ? "size-5" : "size-7",
        className,
      )}
      style={{ background: gradient }}
    >
      <Icon className={cn("text-white", size === "sm" ? "size-3.5" : "size-4")} />
    </span>
  );
}
