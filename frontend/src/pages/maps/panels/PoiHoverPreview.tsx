/**
 * Hover-preview card. Displays the unified identity returned by
 * `resolveHoverIdentity()` so the POI glyph path and the building
 * footprint path show the same title/subtitle/category badge (BUG-1
 * fix in `chunk-04-pins-hover-and-poi-parity.md`).
 */
import { ExternalLinkIcon, PhoneIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { useAdminSettings } from "@/hooks/useAdminSettings";

import { formatPoiCategoryLabel, poiCategoryIconId } from "../poi-icons";
import { poiBgColorFromIconId } from "../poi-colors";
import { PoiIcon } from "../PoiIcon";
import type { HoverIdentity } from "../hover";

function formatDistance(distanceM: number): string {
  if (distanceM >= 1609.344) {
    return `${(distanceM / 1609.344).toFixed(1)} mi`;
  }
  return `${Math.round(distanceM)} m`;
}

function safeHttpUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    try {
      const url = new URL(`https://${trimmed}`);
      return `${url.origin}${url.pathname}${url.search}`;
    } catch {
      return null;
    }
  }
}

export function PoiHoverPreview({
  identity,
  point,
}: {
  identity?: HoverIdentity | null;
  point?: { x: number; y: number } | null;
}): JSX.Element | null {
  if (!identity) {
    return null;
  }
  const { settings: adminSettings } = useAdminSettings();
  const { place, category } = identity;
  const badge = category ? formatPoiCategoryLabel(category, adminSettings.measurementSystem) : "";
  const seen = new Set<string>();
  const skip = new Set(
    [place.title, place.subtitle].map((s) => s.trim()).filter(Boolean),
  );
  const addressLines = place.address_lines
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || skip.has(line) || seen.has(line)) return false;
      seen.add(line);
      return true;
    });
  const tint = poiBgColorFromIconId(poiCategoryIconId(category));
  const websiteHref = safeHttpUrl(place.website);

  const amenityChips: string[] = [];
  const a = place.business_attrs;
  if (a) {
    if (a.wheelchair === "yes") amenityChips.push("♿ Accessible");
    else if (a.wheelchair === "limited") amenityChips.push("♿ Limited access");
    if (a.wifi) amenityChips.push("Wi-Fi");
    if (a.contactless) amenityChips.push("Tap to pay");
    if (a.credit_cards) amenityChips.push("Cards accepted");
    if (a.outdoor_seating) amenityChips.push("Outdoor seating");
    if (a.vegan) amenityChips.push("Vegan options");
    if (a.vegetarian) amenityChips.push("Vegetarian options");
  }

  return (
    <Card
      className="pointer-events-none absolute z-20 w-80 max-w-[min(20rem,calc(100%-2rem))] border border-border/70 bg-background/96 shadow-(--shadow-lg)"
      style={{
        backgroundImage: `linear-gradient(${tint}1f, ${tint}1f)`,
        left: point ? Math.max(16, Math.min(point.x + 18, window.innerWidth - 336)) : 16,
        top: point ? Math.max(16, point.y - 20) : 16,
      }}
    >
      <CardContent className="grid gap-2 py-3 text-sm">
        <div className="flex items-start gap-3">
          <PoiIcon
            kind={category}
            brand_qid={place.brand_qid}
            website={place.website}
            className="mt-0.5 shrink-0"
          />
          <div className="min-w-0 flex-1 space-y-1">
            <span className="line-clamp-2 wrap-break-word font-medium leading-snug">
              {place.title}
            </span>
            {badge ? (
              <div>
                <Badge variant="outline" className="max-w-full whitespace-normal wrap-break-word">
                  {badge}
                </Badge>
              </div>
            ) : null}
            {place.subtitle ? (
              <span className="line-clamp-2 wrap-break-word text-xs text-muted-foreground">
                {place.subtitle}
              </span>
            ) : null}
            {addressLines.slice(0, 2).map((line) => (
              <div key={line} className="line-clamp-2 wrap-break-word text-xs text-muted-foreground">
                {line}
              </div>
            ))}
          </div>
        </div>
        {place.open_now != null ? (
          <div className={cn(
            "rounded-lg px-2 py-1 text-xs font-medium",
            place.open_now
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-rose-500/10 text-rose-600 dark:text-rose-400",
          )}>
            {place.open_now
              ? (place.closes_at ? `Open · Closes ${place.closes_at}` : "Open now")
              : (place.opens_at ? `Closed · Opens ${place.opens_at}` : "Closed")}
            {place.opening_hours_raw ? (
              <span className="ml-1.5 font-normal opacity-70">({place.opening_hours_raw})</span>
            ) : null}
          </div>
        ) : null}
        {amenityChips.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {amenityChips.map((c) => (
              <Badge key={c} variant="outline" className="text-[10px]">{c}</Badge>
            ))}
          </div>
        ) : null}
        {place.distance_m || place.phone || websiteHref ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {place.distance_m ? (
              <Badge variant="outline" className="text-[11px]">
                {formatDistance(place.distance_m)}
              </Badge>
            ) : null}
            {place.phone ? (
              <Badge variant="outline" className="gap-1 text-[11px]">
                <PhoneIcon className="size-3" />
                {place.phone}
              </Badge>
            ) : null}
            {websiteHref ? (
              <Badge asChild variant="outline" className="pointer-events-auto gap-1 text-[11px] cursor-pointer">
                <a href={websiteHref} target="_blank" rel="noopener noreferrer">
                  <ExternalLinkIcon className="size-3" />
                  Website
                </a>
              </Badge>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
