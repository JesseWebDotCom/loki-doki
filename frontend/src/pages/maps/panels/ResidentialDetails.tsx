import { useEffect, useState } from "react";
import { HomeIcon, PhoneIcon, UsersIcon } from "lucide-react";

import {
  lookupProperty,
  lookupPeopleByAddress,
  type PropertyDetails,
  type PersonRecord,
} from "@/lib/lookupApi";
import type { PlaceResult } from "../types";

// Property + resident lookup for a clicked residential address. Renders nothing unless the
// place looks like a home we can resolve to a house/street/city/state. Property data is
// public assessor record (VGSI); residents come from the free ThatsThem directory.

interface ParsedAddress {
  house: string;
  street: string;
  city: string;
  state: string;
  zip?: string;
}

/** Pull house/street/city/state out of a clicked place, or null if it isn't an address. */
function parsePlaceAddress(place: PlaceResult): ParsedAddress | null {
  const lines = [place.title, ...place.address_lines, place.subtitle]
    .map((l) => (l ?? "").trim())
    .filter(Boolean);

  // Street = first line beginning with a house number.
  const streetLine = lines.find((l) => /^\d+[A-Za-z]?(?:-\d+)?\s+\S/.test(l));
  if (!streetLine) return null;
  const sm = streetLine.match(/^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/);
  if (!sm) return null;
  const house = sm[1];
  // Drop a trailing ", City, ST ..." if the street line itself carried the locality.
  const street = sm[2].split(",")[0].trim();

  // City + state: the first line carrying a 2-letter state token.
  let city = "";
  let state = "";
  let zip: string | undefined;
  for (const l of lines) {
    const m = l.match(/([A-Za-z .'-]+),\s*([A-Z]{2})\b[,\s]*(\d{5}(?:-\d{4})?)?/);
    if (m) {
      city = m[1].replace(/^\d+\s+\S.*?,\s*/, "").trim();
      state = m[2];
      zip = m[3];
      break;
    }
  }
  if (!city || !state) return null;
  return { house, street, city, state, zip };
}

function fmtMoney(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return /^\$/.test(t) ? t : `$${t}`;
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-lg bg-muted/40 px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold leading-tight">{value}</p>
    </div>
  );
}

export function ResidentialDetails({ place }: { place: PlaceResult }): JSX.Element | null {
  const parsed = parsePlaceAddress(place);
  // Skip clearly-commercial POIs — those are handled by the normal business card.
  const eligible = parsed != null && !place.website && !place.business_attrs;

  const [property, setProperty] = useState<PropertyDetails | null>(null);
  const [residents, setResidents] = useState<PersonRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAllResidents, setShowAllResidents] = useState(false);

  useEffect(() => {
    if (!eligible || !parsed) return;
    let cancelled = false;
    setLoading(true);
    setProperty(null);
    setResidents([]);
    setShowAllResidents(false);

    void Promise.all([
      lookupProperty(parsed).catch(() => null),
      // People-by-address slug needs the house number in the street line.
      lookupPeopleByAddress({
        street: `${parsed.house} ${parsed.street}`,
        city: parsed.city,
        state: parsed.state,
        zip: parsed.zip,
      }).catch(() => []),
    ]).then(([prop, people]) => {
      if (cancelled) return;
      setProperty(prop);
      setResidents(people);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // Re-run when the resolved address changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, parsed?.house, parsed?.street, parsed?.city, parsed?.state]);

  if (!eligible) return null;

  const stats: { label: string; value: string }[] = [];
  if (property) {
    const beds = property.bedrooms;
    const baths = property.bathrooms;
    if (beds != null) stats.push({ label: "Beds", value: String(beds) });
    if (baths != null) {
      stats.push({
        label: "Baths",
        value: property.halfBaths ? `${baths}.${property.halfBaths >= 1 ? "5" : "0"}` : String(baths),
      });
    }
    if (property.livingAreaSqft != null) stats.push({ label: "Sq Ft", value: property.livingAreaSqft.toLocaleString() });
    if (property.yearBuilt != null) stats.push({ label: "Built", value: String(property.yearBuilt) });
    if (property.lotAcres != null) stats.push({ label: "Lot", value: `${property.lotAcres} ac` });
    const appr = fmtMoney(property.appraisedValue);
    if (appr) stats.push({ label: "Appraised", value: appr });
  }

  const shownResidents = showAllResidents ? residents : residents.slice(0, 3);

  return (
    <div className="mt-3 flex flex-col gap-3">
      {/* Property card */}
      <section className="rounded-xl border border-border/50 bg-background/60">
        <header className="flex items-center gap-2 border-b border-border/30 px-3 py-2">
          <HomeIcon className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Property</h3>
          {loading && !property ? (
            <span className="ml-auto text-xs text-muted-foreground animate-pulse">Looking up…</span>
          ) : null}
        </header>
        <div className="p-3">
          {property ? (
            <>
              {stats.length > 0 ? (
                <div className="grid grid-cols-3 gap-2">
                  {stats.map((s) => (
                    <Stat key={s.label} label={s.label} value={s.value} />
                  ))}
                </div>
              ) : null}
              <div className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
                {property.owner ? (
                  <p>
                    <span className="text-foreground/70">Owner:</span> {property.owner}
                  </p>
                ) : null}
                {property.lastSalePrice ? (
                  <p>
                    <span className="text-foreground/70">Last sale:</span> {fmtMoney(property.lastSalePrice)}
                    {property.lastSaleDate ? ` · ${property.lastSaleDate}` : ""}
                  </p>
                ) : null}
                {property.style || property.useDescription ? (
                  <p>{[property.useDescription, property.style].filter(Boolean).join(" · ")}</p>
                ) : null}
              </div>
              {property.features.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {property.features.map((f) => (
                    <span key={f} className="rounded-full bg-muted/60 px-2 py-0.5 text-[10px] text-foreground/70">
                      {f}
                    </span>
                  ))}
                </div>
              ) : null}
              {property.sourceUrl ? (
                <a
                  href={property.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 block text-[11px] text-primary hover:underline"
                >
                  View assessor record
                </a>
              ) : null}
            </>
          ) : loading ? (
            <div className="h-12 rounded-lg bg-muted/40 animate-pulse" />
          ) : (
            <p className="text-xs text-muted-foreground">No public assessor record found for this address.</p>
          )}
        </div>
      </section>

      {/* Residents card */}
      <section className="rounded-xl border border-border/50 bg-background/60">
        <header className="flex items-center gap-2 border-b border-border/30 px-3 py-2">
          <UsersIcon className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Residents</h3>
          {residents.length > 0 ? (
            <span className="ml-auto text-xs text-muted-foreground">{residents.length}</span>
          ) : null}
        </header>
        <div className="p-3">
          {residents.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border/30">
              {shownResidents.map((r) => (
                <li key={`${r.name}-${r.profileUrl ?? ""}`} className="py-2 first:pt-0 last:pb-0">
                  <p className="text-sm font-medium">{r.name}</p>
                  {r.phones.length > 0 ? (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {r.phones.slice(0, 4).map((phone) => (
                        <a
                          key={phone}
                          href={`tel:${phone.replace(/[^\d+]/g, "")}`}
                          className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                        >
                          <PhoneIcon className="size-3" />
                          {phone}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : loading ? (
            <div className="h-10 rounded-lg bg-muted/40 animate-pulse" />
          ) : (
            <p className="text-xs text-muted-foreground">No listed residents found.</p>
          )}
          {residents.length > 3 ? (
            <button
              type="button"
              onClick={() => setShowAllResidents((v) => !v)}
              className="mt-2 text-xs text-primary hover:underline"
            >
              {showAllResidents ? "Show fewer" : `Show all ${residents.length}`}
            </button>
          ) : null}
        </div>
      </section>

      <p className="px-1 text-[10px] leading-snug text-muted-foreground/70">
        Property data from public assessor records (VGSI). Resident info from ThatsThem — for personal
        reference only.
      </p>
    </div>
  );
}
