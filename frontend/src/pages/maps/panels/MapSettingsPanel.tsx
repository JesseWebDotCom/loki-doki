// Map settings panel — POI visibility + preferences.
// Phase maps-discovery chunk-11.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { EXPLORE_CATEGORIES } from "../explore-categories";
import { isCategoryVisible, type MapPrefs } from "../use-map-prefs";

const POI_GROUPS = [
  { label: "Food & drink", slugs: ["restaurant", "cafe", "bar", "grocery"] },
  { label: "Personal care", slugs: ["hairdresser", "barber", "beauty", "gym"] },
  { label: "Health", slugs: ["pharmacy", "hospital", "clinic", "dentist"] },
  { label: "Civic & services", slugs: ["library", "bank", "post_office", "laundry"] },
  { label: "Lodging & travel", slugs: ["hotel", "gas_station", "atm", "parking"] },
  { label: "Entertainment", slugs: ["museum", "cinema", "park", "optician"] },
] as const;

const LABEL: Record<string, string> = Object.fromEntries(
  EXPLORE_CATEGORIES.map((c) => [c.slug, c.label])
);

export function MapSettingsPanel({
  prefs,
  onChangePref,
  onReset,
}: {
  prefs: MapPrefs;
  onChangePref: <K extends keyof MapPrefs>(key: K, value: MapPrefs[K]) => void;
  onReset: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);

  function toggleCategory(slug: string) {
    const next = { ...prefs.poiVisibility, [slug]: !isCategoryVisible(prefs, slug) };
    onChangePref("poiVisibility", next);
  }

  function isGroupOn(slugs: readonly string[]) {
    return slugs.every((s) => isCategoryVisible(prefs, s));
  }

  function toggleGroup(slugs: readonly string[], on: boolean) {
    const next = { ...prefs.poiVisibility };
    slugs.forEach((s) => { next[s] = on; });
    onChangePref("poiVisibility", next);
  }

  return (
    <section className="grid gap-4">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Map settings</h2>
      <div className="grid gap-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-foreground/50">POI categories</p>
        {POI_GROUPS.map((group) => {
          const on = isGroupOn(group.slugs);
          const open = expanded === group.label;
          return (
            <div key={group.label} className="rounded-xl border border-border/60 bg-card/60 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2">
                <button type="button" onClick={() => setExpanded(open ? null : group.label)} className="flex-1 text-left text-sm font-medium">{group.label}</button>
                <input type="checkbox" checked={on} onChange={(e) => toggleGroup(group.slugs, e.target.checked)} className="size-4 cursor-pointer" />
              </div>
              {open && (
                <div className="border-t border-border/40 grid grid-cols-2 gap-x-4 gap-y-1 px-3 py-2">
                  {group.slugs.map((slug) => (
                    <label key={slug} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input type="checkbox" checked={isCategoryVisible(prefs, slug)} onChange={() => toggleCategory(slug)} className="size-3.5" />
                      {LABEL[slug] ?? slug}
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="grid gap-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-foreground/50">Layers</p>
        {([
          ["showTrafficControls", "Traffic controls"],
          ["showLandcover", "Landcover"],
          ["showTerrain", "Terrain hillshade"],
          ["showRoadHazards", "Road hazards"],
          ["showConstruction", "Construction zones"],
          ["showSpeedCameras", "Speed cameras"],
          ["liveIncidents", "Live road incidents (online)"],
        ] as const).map(([key, label]) => (
          <label key={key} className="flex items-center justify-between rounded-xl border border-border/60 bg-card/60 px-3 py-2 text-sm cursor-pointer">
            {label}
            <input type="checkbox" checked={Boolean(prefs[key])} onChange={(e) => onChangePref(key, e.target.checked as MapPrefs[typeof key])} className="size-4" />
          </label>
        ))}
      </div>
      <div className="grid gap-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-foreground/50">Routing</p>
        {(["avoidTolls", "avoidHighways", "avoidFerries"] as const).map((key) => (
          <label key={key} className={cn("flex items-center justify-between rounded-xl border border-border/60 bg-card/60 px-3 py-2 text-sm cursor-pointer")}>
            {key === "avoidTolls" ? "Avoid tolls" : key === "avoidHighways" ? "Avoid highways" : "Avoid ferries"}
            <input type="checkbox" checked={prefs[key]} onChange={(e) => onChangePref(key, e.target.checked)} className="size-4" />
          </label>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onReset}>Restore defaults</Button>
    </section>
  );
}
