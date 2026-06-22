import {
  ClockIcon,
  CopyIcon,
  GlobeIcon,
  Link2Icon,
  MapPinIcon,
  PhoneIcon,
  RouteIcon,
  UtensilsIcon,
  WifiIcon,
  XIcon,
} from "lucide-react";
import { type ElementType, useState } from "react";

import { cn } from "@/lib/cn";
import { useAdminSettings } from "@/hooks/useAdminSettings";

import { formatPoiCategoryLabel } from "../poi-icons";
import { poiCategoryIconId } from "../poi-icons";
import { poiLucideIcon } from "../poi-lucide-icons";
import { PoiIcon } from "../PoiIcon";
import type { PlaceResult } from "../types";
import { sharePlaceToClipboard } from "../use-share-place";
import { usePlaceDescription } from "./use-place-description";

// ── helpers ───────────────────────────────────────────────────────────────────

// Returns true if closes_at (e.g. "9 PM") is within the next 60 minutes.
function isClosingSoon(closesAt: string | null | undefined): boolean {
  if (!closesAt) return false;
  const m = closesAt.match(/^(\d+)(?::(\d+))?\s*(AM|PM)$/i);
  if (!m) return false;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2] ?? "0", 10);
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  const now = new Date();
  const closesMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min).getTime();
  return closesMs > now.getTime() && closesMs - now.getTime() < 60 * 60 * 1000;
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
      if (url.protocol !== "https:") return null;
      return `${url.origin}${url.pathname}${url.search}`;
    } catch {
      return null;
    }
  }
}

function displayHostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const trimmed = raw.trim();
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] || null;
  }
}

interface ActionItem {
  label: string;
  icon: ElementType<{ className?: string }>;
  href?: string;
  external?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

export function PlaceDetailsCard({
  place,
  onClose,
  onDirections,
  flat = false,
}: {
  place: PlaceResult | null;
  onClose: () => void;
  onDirections: (place: PlaceResult) => void;
  flat?: boolean;
}): JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const { settings: adminSettings } = useAdminSettings();
  const fetchedDesc = usePlaceDescription(place);

  if (!place) return null;

  const telHref = place.phone ? `tel:${place.phone.replace(/[^\d+\-.() ]/g, "")}` : null;
  const websiteHref = safeHttpUrl(place.website);
  const websiteDisplay = displayHostname(place.website);
  const menuHref = safeHttpUrl(place.menu_url);

  // Only skip the POI name itself; keep the subtitle (city/state) so it shows in the address row.
  const skip = new Set([place.title].map((s) => s?.trim()).filter(Boolean));
  const seen = new Set<string>();
  const addressLines = place.address_lines
    .map((l) => l.trim().replace(/^near\s+/i, ""))
    .filter((l) => {
      if (!l || skip.has(l) || seen.has(l)) return false;
      seen.add(l);
      return true;
    });
  const coordFallback = `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;

  async function handleCopyAddress(): Promise<void> {
    const text = addressLines.length > 0 ? addressLines.join(", ") : coordFallback;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  const actions: ActionItem[] = [
    { label: "Directions", icon: RouteIcon, onClick: () => onDirections(place) },
    { label: "Copy link", icon: Link2Icon, onClick: () => sharePlaceToClipboard(place) },
    { label: "Call", icon: PhoneIcon, href: telHref ?? undefined, disabled: !telHref },
    { label: "Website", icon: GlobeIcon, href: websiteHref ?? undefined, external: true, disabled: !websiteHref },
  ];

  const categoryLabel = place.kind ? (formatPoiCategoryLabel(place.kind, adminSettings.measurementSystem) || place.kind) : null;
  const CategoryIcon = poiLucideIcon(poiCategoryIconId(place.kind ?? null));

  return (
    <section
      role="tabpanel"
      aria-label="Place details"
      className={cn(
        "flex flex-col min-w-0 max-w-full",
        !flat && "rounded-3xl border border-border/70 bg-background/92 p-4 shadow-(--shadow-lg)",
      )}
    >
      {/* Name + category + close */}
      <div className="flex items-start gap-3 pt-3 pb-2">
        <PoiIcon
          kind={place.kind}
          brand_qid={place.brand_qid}
          website={place.website}
          className="mt-0.5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 text-base font-semibold leading-snug wrap-break-word">
            {place.title}
          </h2>
          {place.subtitle ? (
            <p className="text-xs text-muted-foreground mt-0.5 wrap-break-word animate-in fade-in duration-300">{place.subtitle}</p>
          ) : null}
          {categoryLabel ? (
            <p className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
              <CategoryIcon className="size-3 shrink-0" strokeWidth={2} />
              {categoryLabel}
            </p>
          ) : null}
          {place.business_attrs?.stars ? (
            <p className="text-xs text-amber-500 mt-0.5">
              {"★".repeat(place.business_attrs.stars)}
              {"☆".repeat(5 - place.business_attrs.stars)}
            </p>
          ) : null}
          {place.business_attrs?.cuisine?.length ? (
            <p className="text-xs text-muted-foreground mt-0.5 capitalize">
              {place.business_attrs.cuisine.join(" · ")}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground shrink-0"
        >
          <XIcon className="size-4" />
        </button>
      </div>

      {/* Quick action buttons */}
      <div className="flex justify-around border-y border-border/30 py-3 gap-1">
        {actions.map((action) => {
          const Icon = action.icon;
          const icon = (
            <span
              className={cn(
                "flex size-10 items-center justify-center rounded-full bg-muted/60 text-foreground/80 transition-opacity duration-300",
                action.disabled ? "opacity-30" : "hover:bg-muted",
              )}
            >
              <Icon className="size-4" />
            </span>
          );
          const label = (
            <span
              className={cn(
                "text-[10px] font-medium leading-none mt-0.5 transition-opacity duration-300",
                action.disabled ? "text-foreground/30" : "text-foreground/70",
              )}
            >
              {action.label}
            </span>
          );
          if (action.disabled) {
            return (
              <div key={action.label} className="flex flex-col items-center gap-0.5" aria-disabled="true">
                {icon}
                {label}
              </div>
            );
          }
          if (action.href) {
            return (
              <a
                key={action.label}
                href={action.href}
                {...(action.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="flex flex-col items-center gap-0.5 focus-visible:outline-none"
              >
                {icon}
                {label}
              </a>
            );
          }
          return (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              className="flex flex-col items-center gap-0.5 focus-visible:outline-none"
            >
              {icon}
              {label}
            </button>
          );
        })}
      </div>

      {/* Detail rows with icon + content */}
      <div className="flex flex-col divide-y divide-border/30 text-sm">
        <div className="flex items-start gap-3 py-3">
          <MapPinIcon className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            {addressLines.length > 0 ? (
              addressLines.map((l) => (
                <p key={l} className="wrap-break-word animate-in fade-in duration-300">{l}</p>
              ))
            ) : (
              <p className="text-muted-foreground/60 text-xs tabular-nums">{coordFallback}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void handleCopyAddress()}
            title={copied ? "Copied!" : "Copy address"}
            className="shrink-0 p-1 text-muted-foreground hover:text-foreground"
          >
            <CopyIcon className="size-3.5" />
          </button>
        </div>

        {place.open_now != null ? (
          <div className="flex items-center gap-3 py-3 animate-in fade-in duration-300">
            <ClockIcon className="size-4 shrink-0 text-muted-foreground" />
            {place.open_now ? (
              isClosingSoon(place.closes_at) ? (
                <span className="font-medium text-amber-600 dark:text-amber-400">
                  Closing soon
                  {place.closes_at ? ` · ${place.closes_at}` : ""}
                </span>
              ) : (
                <span className="font-medium text-emerald-600 dark:text-emerald-400">
                  {place.closes_at ? `Open · Closes ${place.closes_at}` : "Open now"}
                </span>
              )
            ) : (
              <span className="font-medium text-rose-600 dark:text-rose-400">
                {place.opens_at ? `Closed · Opens ${place.opens_at}` : "Closed"}
              </span>
            )}
          </div>
        ) : null}

        {place.business_attrs?.wifi ? (
          <div className="flex items-center gap-3 py-3 animate-in fade-in duration-300">
            <WifiIcon className="size-4 shrink-0 text-muted-foreground" />
            <span>Wi-Fi available</span>
          </div>
        ) : null}

        {websiteHref && websiteDisplay ? (
          <div className="flex items-center gap-3 py-3 animate-in fade-in duration-300">
            <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
            <a
              href={websiteHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline truncate"
            >
              {websiteDisplay}
            </a>
          </div>
        ) : null}

        {menuHref ? (
          <div className="flex items-center gap-3 py-3 animate-in fade-in duration-300">
            <UtensilsIcon className="size-4 shrink-0 text-muted-foreground" />
            <a
              href={menuHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline truncate"
            >
              View menu
            </a>
          </div>
        ) : null}

        {telHref ? (
          <div className="flex items-center gap-3 py-3 animate-in fade-in duration-300">
            <PhoneIcon className="size-4 shrink-0 text-muted-foreground" />
            <a href={telHref} className="hover:underline">{place.phone}</a>
          </div>
        ) : null}
      </div>

      {/* About / description */}
      {(() => {
        const text = place.wiki_summary ?? fetchedDesc?.text ?? null;
        const url = place.wiki_url ?? fetchedDesc?.url ?? null;
        if (!text) return null;
        return (
          <div className="mt-3 rounded-xl bg-muted/40 px-3 py-2.5 text-sm animate-in fade-in duration-500">
            <p className="text-muted-foreground line-clamp-5">{text}</p>
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 block text-xs text-primary hover:underline"
              >
                Read more on Wikipedia
              </a>
            ) : null}
          </div>
        );
      })()}

      {/* Business attributes — shown as icon+label rows like WiFi */}
      {place.business_attrs ? (() => {
        const a = place.business_attrs!;
        type AttrRow = { icon: string; label: string };
        const rows: AttrRow[] = [];
        if (a.wheelchair === "yes") rows.push({ icon: "♿", label: "Wheelchair accessible" });
        else if (a.wheelchair === "limited") rows.push({ icon: "♿", label: "Limited wheelchair access" });
        if (a.outdoor_seating) rows.push({ icon: "🪑", label: "Outdoor seating" });
        if (a.contactless) rows.push({ icon: "📲", label: "Tap to pay" });
        if (a.credit_cards) rows.push({ icon: "💳", label: "Cards accepted" });
        if (a.vegan) rows.push({ icon: "🥗", label: "Vegan options" });
        if (a.vegetarian) rows.push({ icon: "🥦", label: "Vegetarian options" });
        if (a.takeaway) rows.push({ icon: "🥡", label: "Takeout" });
        if (a.delivery) rows.push({ icon: "🚚", label: "Delivery" });
        if (a.fee) rows.push({ icon: "💰", label: "Paid entry" });
        if (a.smoking === "no") rows.push({ icon: "🚭", label: "No smoking" });
        else if (a.smoking && a.smoking !== "no") rows.push({ icon: "🚬", label: "Smoking area" });
        if (!rows.length) return null;
        return (
          <div className="mt-1 flex flex-col divide-y divide-border/30 text-sm animate-in fade-in duration-300">
            {rows.map(({ icon, label }) => (
              <div key={label} className="flex items-center gap-3 py-2.5">
                <span className="w-4 text-center text-base leading-none shrink-0">{icon}</span>
                <span>{label}</span>
              </div>
            ))}
          </div>
        );
      })() : null}
    </section>
  );
}
