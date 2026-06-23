import { useState } from "react";
import { PhoneIcon, SearchIcon, UserIcon, MapPinIcon, HomeIcon } from "lucide-react";

import { PageShell } from "@/components/shared/PageShell";
import { PageHeader } from "@/components/shared/PageHeader";
import { usePublishUIContext } from "@/context/UIContextProvider";
import { cn } from "@/lib/cn";
import {
  lookupPeopleByAddress,
  lookupPeopleByName,
  lookupPeopleByPhone,
  lookupProperty,
  type PersonRecord,
  type PropertyDetails,
} from "@/lib/lookupApi";

type Mode = "address" | "name" | "phone";

const GRADIENT = "linear-gradient(135deg,#1e3a5f,#2563eb)";

const MODES: { id: Mode; label: string; icon: typeof SearchIcon }[] = [
  { id: "address", label: "Address", icon: MapPinIcon },
  { id: "name", label: "Name", icon: UserIcon },
  { id: "phone", label: "Phone", icon: PhoneIcon },
];

function fmtMoney(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return /^\$/.test(t) ? t : `$${t}`;
}

function PersonCard({ person }: { person: PersonRecord }): JSX.Element {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <p className="text-base font-semibold">{person.name}</p>
      {person.phones.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {person.phones.map((phone) => (
            <a
              key={phone}
              href={`tel:${phone.replace(/[^\d+]/g, "")}`}
              className="flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <PhoneIcon className="size-3.5" />
              {phone}
            </a>
          ))}
        </div>
      ) : null}
      {person.addresses.length > 0 ? (
        <div className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
          {person.addresses.slice(0, 3).map((a, i) => (
            <p key={i} className="flex items-start gap-1.5">
              <MapPinIcon className="mt-0.5 size-3 shrink-0" />
              {[a.street, a.city, a.state, a.zip].filter(Boolean).join(", ")}
            </p>
          ))}
        </div>
      ) : null}
      {person.associates.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="text-foreground/70">Associated:</span> {person.associates.slice(0, 5).join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function PropertyCard({ property }: { property: PropertyDetails }): JSX.Element {
  const rows: [string, string][] = [];
  if (property.owner) rows.push(["Owner", property.owner]);
  if (property.bedrooms != null) rows.push(["Bedrooms", String(property.bedrooms)]);
  if (property.bathrooms != null) {
    rows.push(["Bathrooms", property.halfBaths ? `${property.bathrooms} + ${property.halfBaths} half` : String(property.bathrooms)]);
  }
  if (property.livingAreaSqft != null) rows.push(["Living area", `${property.livingAreaSqft.toLocaleString()} sq ft`]);
  if (property.yearBuilt != null) rows.push(["Year built", String(property.yearBuilt)]);
  if (property.lotAcres != null) rows.push(["Lot size", `${property.lotAcres} acres`]);
  if (property.style) rows.push(["Style", property.style]);
  const appr = fmtMoney(property.appraisedValue);
  if (appr) rows.push(["Appraised value", appr]);
  const land = fmtMoney(property.landValue);
  if (land) rows.push(["Land value", land]);
  if (property.lastSalePrice) {
    rows.push(["Last sale", `${fmtMoney(property.lastSalePrice)}${property.lastSaleDate ? ` · ${property.lastSaleDate}` : ""}`]);
  }
  if (property.zoning) rows.push(["Zoning", property.zoning]);

  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="mb-2 flex items-center gap-2">
        <HomeIcon className="size-4 text-muted-foreground" />
        <p className="text-sm font-semibold">{property.address ?? "Property record"}</p>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      {property.features.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {property.features.map((f) => (
            <span key={f} className="rounded-full bg-muted/60 px-2 py-0.5 text-[11px] text-foreground/70">
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
          className="mt-3 block text-xs text-primary hover:underline"
        >
          View assessor record
        </a>
      ) : null}
    </div>
  );
}

const inputCls = cn(
  "w-full rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 text-sm",
  "focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand/60 transition-colors",
);

export function ReverseLookupPage(): JSX.Element {
  const [mode, setMode] = useState<Mode>("address");

  // Address fields (street/city/state/zip)
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [zip, setZip] = useState("");
  // Name fields
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [nameState, setNameState] = useState("");
  // Phone
  const [phone, setPhone] = useState("");

  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [property, setProperty] = useState<PropertyDetails | null>(null);

  usePublishUIContext({
    label: "Reverse Lookup",
    description: "User is looking up people or property by address, name, or phone.",
  });

  async function runSearch(): Promise<void> {
    setLoading(true);
    setSearched(true);
    setPeople([]);
    setProperty(null);
    try {
      if (mode === "address") {
        const m = street.trim().match(/^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/);
        const [prop, residents] = await Promise.all([
          m ? lookupProperty({ house: m[1], street: m[2], city: city.trim(), state: stateCode.trim() }).catch(() => null) : Promise.resolve(null),
          lookupPeopleByAddress({ street: street.trim(), city: city.trim(), state: stateCode.trim(), zip: zip.trim() || undefined }).catch(() => []),
        ]);
        setProperty(prop);
        setPeople(residents);
      } else if (mode === "name") {
        setPeople(await lookupPeopleByName({ first: first.trim(), last: last.trim(), state: nameState.trim() || undefined }));
      } else {
        setPeople(await lookupPeopleByPhone(phone.trim()));
      }
    } finally {
      setLoading(false);
    }
  }

  const canSearch =
    mode === "address"
      ? Boolean(street.trim() && city.trim() && stateCode.trim())
      : mode === "name"
        ? Boolean(first.trim() && last.trim())
        : phone.replace(/\D/g, "").length >= 10;

  return (
    <PageShell gradient={GRADIENT} GhostIcon={SearchIcon}>
      <PageHeader
        variant="compact"
        title="Reverse Lookup"
        gradient={GRADIENT}
        icon={<SearchIcon className="size-7 text-white" />}
      />

      <div className="px-5 pb-10">
        {/* Mode tabs */}
        <div className="mb-4 flex gap-2">
          {MODES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => {
                setMode(id);
                setSearched(false);
                setPeople([]);
                setProperty(null);
              }}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold transition-colors",
                mode === id ? "bg-brand text-white" : "bg-foreground/8 text-foreground/70 hover:bg-foreground/12",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>

        {/* Form */}
        <form
          className="flex flex-col gap-2.5 rounded-2xl border border-border/60 bg-card p-4 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSearch && !loading) void runSearch();
          }}
        >
          {mode === "address" ? (
            <>
              <input className={inputCls} placeholder="Street address (e.g. 150 Stiles St)" value={street} onChange={(e) => setStreet(e.target.value)} />
              <div className="flex gap-2">
                <input className={inputCls} placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} />
                <input className={cn(inputCls, "w-20")} placeholder="ST" maxLength={2} value={stateCode} onChange={(e) => setStateCode(e.target.value.toUpperCase())} />
                <input className={cn(inputCls, "w-28")} placeholder="ZIP" value={zip} onChange={(e) => setZip(e.target.value)} />
              </div>
            </>
          ) : mode === "name" ? (
            <div className="flex gap-2">
              <input className={inputCls} placeholder="First name" value={first} onChange={(e) => setFirst(e.target.value)} />
              <input className={inputCls} placeholder="Last name" value={last} onChange={(e) => setLast(e.target.value)} />
              <input className={cn(inputCls, "w-20")} placeholder="ST" maxLength={2} value={nameState} onChange={(e) => setNameState(e.target.value.toUpperCase())} />
            </div>
          ) : (
            <input className={inputCls} placeholder="Phone number (e.g. 203-555-0100)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          )}

          <button
            type="submit"
            disabled={!canSearch || loading}
            className={cn(
              "mt-1 flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-opacity",
              (!canSearch || loading) && "opacity-40",
            )}
          >
            <SearchIcon className="size-4" />
            {loading ? "Searching…" : "Search"}
          </button>
        </form>

        {/* Results */}
        <div className="mt-5 flex flex-col gap-3">
          {property ? <PropertyCard property={property} /> : null}
          {people.map((p, i) => (
            <PersonCard key={`${p.name}-${i}`} person={p} />
          ))}
          {searched && !loading && people.length === 0 && !property ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No results found.</p>
          ) : null}
        </div>

        <p className="mt-6 text-[11px] leading-snug text-muted-foreground/70">
          Property data from public assessor records (Vision Government Solutions). People data from the
          ThatsThem directory. For personal reference only — not for tenant screening, employment, credit, or
          any other FCRA-regulated decision.
        </p>
      </div>
    </PageShell>
  );
}
