import { cn } from "@/lib/cn";

const widthMap = {
  default: "max-w-6xl",
  narrow: "max-w-3xl",
  wide: "max-w-[88rem]",
  full: "max-w-none",
} as const;

export type PageContainerWidth = keyof typeof widthMap;

interface PageContainerProps {
  /** Canonical content widths: default 72rem, narrow 48rem (settings/readers),
   *  wide 88rem (media grids), full (escape hatch for full-bleed surfaces). */
  width?: PageContainerWidth;
  children: React.ReactNode;
  className?: string;
}

/**
 * The one page-content container: canonical max-width + horizontal gutters.
 * Every page wraps its scrollable content in this instead of picking its own
 * `mx-auto max-w-* px-*` combo (enforced by check:design-contract).
 */
export function PageContainer({ width = "default", children, className }: PageContainerProps) {
  return (
    <div className={cn("mx-auto w-full px-4 sm:px-6 lg:px-8", widthMap[width], className)}>
      {children}
    </div>
  );
}
