// ExplorePanel — category chip grid shown in the LeftRail idle state.
// Phase maps-discovery chunk-03.
//
// When the search box is empty and no panel is active, this fills the
// rail content area with a 4-wide grid of category chips. Tapping a
// chip calls onSelectCategory(slug) so MapsPage can switch to a
// category-filtered search.

import { cn } from "@/lib/cn";
import { EXPLORE_CATEGORIES } from "../explore-categories";
import { poiLucideIcon } from "../poi-lucide-icons";

export function ExplorePanel({
  onSelectCategory,
}: {
  onSelectCategory: (slug: string) => void;
}): JSX.Element {
  return (
    <section aria-label="Browse by category" className="grid gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground/50">
        Browse nearby
      </h2>
      <div className="grid grid-cols-4 gap-2">
        {EXPLORE_CATEGORIES.map(({ slug, label }) => {
          const Icon = poiLucideIcon(slug);
          return (
            <button
              key={slug}
              type="button"
              data-testid={`explore-category-${slug}`}
              onClick={() => onSelectCategory(slug)}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-xl border border-border/60 bg-card/70 px-2 py-3",
                "text-center text-[11px] text-foreground/80 transition-colors",
                "hover:border-primary/40 hover:bg-primary/5 hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              )}
            >
              <Icon className="size-5 shrink-0 text-foreground/60" />
              <span className="w-full truncate leading-tight">{label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
