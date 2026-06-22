/**
 * Unified POI icon: shows a brand logo/favicon when available, falls back
 * to the category-colored circle with a Lucide icon.
 *
 * Used in search results, recents, spotlight, hover card, details card,
 * and the map selection marker.
 */
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";

import { poiBgColorFromIconId } from "./poi-colors";
import { poiCategoryIconId } from "./poi-icons";
import { poiLucideIcon } from "./poi-lucide-icons";

function faviconFromWebsite(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const url = new URL(website.startsWith("http") ? website : `https://${website}`);
    return `/api/maps/favicon?host=${encodeURIComponent(url.hostname)}`;
  } catch {
    return null;
  }
}

export interface PoiIconProps {
  kind?: string | null;
  brand_qid?: string | null;
  website?: string | null;
  /** Tailwind size class, e.g. "size-9" (default) or "size-8". */
  sizeClass?: string;
  /** Extra classes on the outer container. */
  className?: string;
}

export function PoiIcon({
  kind,
  brand_qid,
  website,
  sizeClass = "size-9",
  className,
}: PoiIconProps): JSX.Element {
  const iconId = poiCategoryIconId(kind ?? null);
  const Icon = poiLucideIcon(iconId);
  const tint = poiBgColorFromIconId(iconId);

  const brandSrc = brand_qid ? `/api/maps/logos/${brand_qid}.png` : null;
  const faviconSrc = faviconFromWebsite(website);

  // tri-state: "brand" → "favicon" → "icon"
  const [stage, setStage] = useState<"brand" | "favicon" | "icon">(
    brandSrc ? "brand" : faviconSrc ? "favicon" : "icon",
  );
  // Reset when switching to a different POI (same component instance, new props).
  useEffect(() => {
    setStage(brandSrc ? "brand" : faviconSrc ? "favicon" : "icon");
  }, [brandSrc, faviconSrc]);

  const logoSrc = stage === "brand" ? brandSrc : stage === "favicon" ? faviconSrc : null;

  if (logoSrc) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full border border-border/30 bg-white overflow-hidden",
          sizeClass,
          className,
        )}
      >
        <img
          src={logoSrc}
          alt=""
          aria-hidden
          className="size-full object-contain p-1"
          onError={() => {
            if (stage === "brand" && faviconSrc) {
              setStage("favicon");
            } else {
              setStage("icon");
            }
          }}
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border border-white/80 shadow-sm",
        sizeClass,
        className,
      )}
      style={{ backgroundColor: tint }}
    >
      <Icon className="size-4 text-white" strokeWidth={2.2} />
    </span>
  );
}
