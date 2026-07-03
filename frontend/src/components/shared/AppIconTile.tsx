import { cn } from "@/lib/cn";
import type { LucideIcon } from "lucide-react";

interface AppIconTileProps {
  icon: LucideIcon;
  gradient: string;
  /** Single solid accent (AppItem.color). Required when variant="flat". */
  color?: string;
  /** "gradient" (default) = the app's full multi-stop registry gradient, reserved for
   *  sparser, larger identity moments (breadcrumb crumb, PageHeader/AppRailHeader tiles).
   *  "flat" = a soft tint of the app's single solid color with a colored icon (not a
   *  solid fill), for dense, repeated contexts like sidebar nav rows, where a wall of
   *  fully-saturated tiles (gradient OR solid) reads as a sticker sheet. */
  variant?: "gradient" | "flat";
  /** "sm" = size-5 container / size-3.5 icon (sidebar, breadcrumb).
   *  "md" = size-7 container / size-4 icon (larger contexts).
   *  "lg" = size-12 container / size-6 icon, rounded-card (app-launcher tiles). */
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function AppIconTile({ icon: Icon, gradient, color, variant = "gradient", size = "sm", className }: AppIconTileProps) {
  const flat = variant === "flat"
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        size === "lg" && "size-12 rounded-card",
        size === "sm" && "size-5 rounded-[7px]",
        size === "md" && "size-7 rounded-control",
        className,
      )}
      style={flat
        ? { backgroundColor: `color-mix(in oklch, ${color ?? gradient} 16%, transparent)` }
        : { background: gradient }}
    >
      <Icon
        className={cn(
          !flat && "text-white",
          size === "sm" && "size-3.5",
          size === "md" && "size-4",
          size === "lg" && "size-6",
        )}
        style={flat ? { color: color ?? gradient } : undefined}
      />
    </span>
  );
}
