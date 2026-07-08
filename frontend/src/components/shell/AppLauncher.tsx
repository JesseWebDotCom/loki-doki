import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog as RadixDialog } from "radix-ui";
import { ArrowRight, Search, Star, StarOff, type LucideIcon } from "lucide-react";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { APP_GROUPS } from "@/lib/appCategories";
import { categoryVisual } from "@/lib/archiveCategories";
import { useAppFeatures } from "@/hooks/useAppFeatures";
import { useInstalledArchives } from "@/hooks/useInstalledArchives";
import { useStoreApps, STORE_CATEGORIES, type StoreApp } from "@/lib/store/useStoreApps";
import { useIntentPrefetch } from "@/lib/prefetch/useIntentPrefetch";
import { AppIconTile } from "@/components/shared/AppIconTile";
import { ArchiveIcon } from "@/components/shared/ArchiveIcon";
import { Chip, ChipRow } from "@/components/shared/ChipRow";
import { toast } from "@/lib/toast";

// Launchpad-style overlay opened from the sidebar's "Apps" entry. Browsing
// surface for everything launchable. The grid is driven by the App Store's
// enriched catalog (useStoreApps), so every installed app appears under the
// same category the store assigns it; the chip row filters by those same
// categories. Pin state is shared with the sidebar Favorites list via props
// (one useNavPreferences instance, owned by LeftSidebar).

interface LauncherEntry {
  /** Pin key: app id, or `read:<sourceId>` for archives. */
  id: string;
  label: string;
  description?: string;
  href: string;
  icon?: LucideIcon;
  gradient?: string;
  color?: string;
  categoryKey?: string;
  /** false = not resolvable by the sidebar Favorites list, so no pin affordance. */
  pinnable?: boolean;
}

interface AppLauncherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pinnedIds: readonly string[];
  recentIds: readonly string[];
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
}

interface AppLauncherBodyProps {
  /** Whether the launcher surface is currently visible (resets search when it becomes active). */
  active: boolean;
  /** Called after a navigation so the host (dialog / sheet) can close. */
  onClose: () => void;
  pinnedIds: readonly string[];
  recentIds: readonly string[];
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  /** Overrides the grid scroller height (dialog uses a fixed height; the mobile sheet flex-fills). */
  scrollerClassName?: string;
  className?: string;
}

const RECENTS_MAX = 8;
const NOTEWORTHY_MAX = 6;

function matches(q: string, ...fields: (string | undefined)[]): boolean {
  if (!q) return true;
  return fields.some((f) => f?.toLowerCase().includes(q));
}

function ArchiveTileIcon({ zimIconUrl, category }: { zimIconUrl: string | null; category: string }) {
  const visual = categoryVisual(category);
  return (
    <span
      className="flex size-14 shrink-0 items-center justify-center rounded-card shadow-lg shadow-black/25 ring-1 ring-inset ring-white/10"
      style={{ background: visual.gradient }}
    >
      <ArchiveIcon zimIconUrl={zimIconUrl} category={category} className="size-7" />
    </span>
  );
}

function LaunchTile({
  entry,
  iconNode,
  pinned,
  onOpen,
  onTogglePin,
  onIntent,
  onHover,
  fixedWidth,
}: {
  entry: LauncherEntry;
  /** Overrides the AppIconTile (archive favicons, dashed store tiles). */
  iconNode?: React.ReactNode;
  pinned?: boolean;
  onOpen: () => void;
  /** When set, a favorite-star affordance appears on hover. */
  onTogglePin?: () => void;
  onIntent?: () => void;
  /** Feeds the footer info bar while the tile is hovered or focused. */
  onHover?: (entry: LauncherEntry | null) => void;
  /** Fixed tile width for horizontal rows (recents). */
  fixedWidth?: boolean;
}) {
  return (
    <div className={cn("group/tile relative", fixedWidth && "w-24 shrink-0")}>
      <button
        type="button"
        onClick={onOpen}
        onPointerEnter={() => {
          onIntent?.();
          onHover?.(entry);
        }}
        onPointerLeave={() => onHover?.(null)}
        onFocus={() => {
          onIntent?.();
          onHover?.(entry);
        }}
        onBlur={() => onHover?.(null)}
        className={cn(
          "flex w-full flex-col items-center gap-2 rounded-card px-2 pb-2 pt-3 transition-colors",
          "hover:bg-foreground/[0.04]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {iconNode ??
          (entry.icon && entry.gradient ? (
            <AppIconTile icon={entry.icon} gradient={entry.gradient} color={entry.color} size="lg" />
          ) : null)}
        <span className="w-full truncate text-center text-caption leading-tight text-foreground/90">
          {entry.label}
        </span>
      </button>
      {onTogglePin && (
        <button
          type="button"
          onClick={onTogglePin}
          aria-label={pinned ? `Remove ${entry.label} from favorites` : `Add ${entry.label} to favorites`}
          className={cn(
            "absolute right-1 top-1 flex size-6 items-center justify-center rounded-full",
            "bg-secondary/90 shadow-sm",
            // Favorited tiles always show their star so favorite state is
            // visible at a glance; others reveal the star on hover.
            pinned
              ? "text-warning"
              : "text-muted-foreground opacity-0 transition-opacity group-hover/tile:opacity-100 hover:text-foreground",
            "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {pinned ? (
            <>
              <Star className="size-3 fill-current group-hover/tile:hidden" aria-hidden="true" />
              <StarOff className="hidden size-3 group-hover/tile:block" aria-hidden="true" />
            </>
          ) : (
            <Star className="size-3" aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}

function SectionHeading({ label }: { label: string }) {
  return (
    <div className="mb-2 flex items-center px-2">
      <h3 className="text-overline text-muted-foreground">{label}</h3>
    </div>
  );
}

const GRID_CLASS = "grid grid-cols-3 gap-x-1 gap-y-2 sm:grid-cols-5 md:grid-cols-7";

export function AppLauncher({ open, onOpenChange, pinnedIds, recentIds, onPin, onUnpin }: AppLauncherProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        {/* Bespoke content (not ui/DialogContent): flush Spotlight-style chrome
            without the baked-in corner close button. */}
        <RadixDialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col",
            "overflow-hidden rounded-sheet border border-border bg-popover shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          <RadixDialog.Title className="sr-only">Apps</RadixDialog.Title>
          <AppLauncherBody
            active={open}
            onClose={() => onOpenChange(false)}
            pinnedIds={pinnedIds}
            recentIds={recentIds}
            onPin={onPin}
            onUnpin={onUnpin}
          />
        </RadixDialog.Content>
      </DialogPortal>
    </Dialog>
  );
}

export function AppLauncherBody({ active, onClose, pinnedIds, recentIds, onPin, onUnpin, scrollerClassName, className }: AppLauncherBodyProps) {
  const navigate = useNavigate();
  const prefetch = useIntentPrefetch();
  const appFeatures = useAppFeatures();
  const { data: installedArchives } = useInstalledArchives();
  const { apps: storeApps } = useStoreApps();
  const [query, setQuery] = useState("");
  const [activeCat, setActiveCat] = useState("all");
  const [hovered, setHovered] = useState<LauncherEntry | null>(null);

  // Fresh search + filter each time the launcher opens.
  useEffect(() => {
    if (active) {
      setQuery("");
      setActiveCat("all");
      setHovered(null);
    }
  }, [active]);

  const q = query.trim().toLowerCase();
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  // APP_GROUPS catalog lookup by route: pin keys, feature gates, and canonical
  // labels for tool-backed apps (StoreApp ids are tool ids, sidebar pins are
  // catalog ids).
  const catalogByRoute = useMemo(() => {
    const m = new Map<string, { id: string; label: string; feature?: string }>();
    for (const g of APP_GROUPS)
      for (const a of g.apps) m.set(a.to, { id: a.id, label: a.label, feature: a.feature });
    return m;
  }, []);

  const categoryGradients = useMemo(
    () => new Map(STORE_CATEGORIES.map((c) => [c.key, c.gradient])),
    [],
  );

  // Installed, launchable apps from the store catalog, categorized exactly as
  // the App Store categorizes them. Deduped by route (news + localNews share
  // /news) and feature-gated via the APP_GROUPS catalog.
  const apps = useMemo(() => {
    const seenRoutes = new Set<string>();
    const out: LauncherEntry[] = [];
    for (const a of storeApps) {
      if (!a.enabled || !a.route) continue;
      if (seenRoutes.has(a.route)) continue;
      const catalog = catalogByRoute.get(a.route);
      if (catalog?.feature && appFeatures[catalog.feature] === false) continue;
      seenRoutes.add(a.route);
      out.push({
        id: catalog?.id ?? a.id,
        label: catalog?.label ?? a.name,
        description: a.description,
        href: a.route,
        icon: a.icon,
        gradient: a.gradient ?? categoryGradients.get(a.categoryKey),
        color: a.accent,
        categoryKey: a.categoryKey,
        pinnable: !!catalog,
      });
    }
    return out.sort((x, y) => x.label.localeCompare(y.label));
  }, [storeApps, catalogByRoute, categoryGradients, appFeatures]);

  const archives = useMemo(
    () =>
      (installedArchives ?? []).map((a) => ({
        entry: {
          id: `read:${a.sourceId}`,
          label: a.label ?? a.sourceId,
          description: a.description ?? undefined,
          href: `/read/${a.sourceId}`,
          pinnable: true,
        } satisfies LauncherEntry,
        zimIconUrl: a.zimIconUrl ?? null,
        category: a.category ?? "Other",
      })),
    [installedArchives],
  );

  // Chip row: All + the store categories that have installed apps + Libraries.
  const categories = useMemo(
    () => STORE_CATEGORIES.filter((c) => apps.some((a) => a.categoryKey === c.key)),
    [apps],
  );

  // Recents: `nav.recent_apps` keys resolved against installed apps + archives.
  const recents = useMemo(() => {
    const appById = new Map(apps.map((a) => [a.id, a]));
    const archiveByKey = new Map(archives.map((a) => [a.entry.id, a]));
    const out: { entry: LauncherEntry; archive?: (typeof archives)[number] }[] = [];
    for (const id of recentIds) {
      if (out.length >= RECENTS_MAX) break;
      const archive = archiveByKey.get(id);
      if (archive) {
        out.push({ entry: archive.entry, archive });
        continue;
      }
      const app = appById.get(id);
      if (app) out.push({ entry: app });
    }
    return out;
  }, [recentIds, apps, archives]);

  // Not-yet-installed App Store apps (the store is apps-only).
  const noteworthy = useMemo(
    () => storeApps.filter((a) => !a.enabled),
    [storeApps],
  );

  // One unified alphabetical grid (Launchpad-style), scoped by chip + query.
  // Installed offline archives are just apps to the user: they mix into "All"
  // and surface under Reading & Reference, with no category of their own.
  const gridItems = useMemo(() => {
    const appItems = apps
      .filter((a) => activeCat === "all" || a.categoryKey === activeCat)
      .filter((a) => matches(q, a.label, a.description))
      .map((entry) => ({ entry, archive: undefined as (typeof archives)[number] | undefined }));
    const archiveItems =
      activeCat === "all" || activeCat === "reading"
        ? archives
            .filter((a) => matches(q, a.entry.label, a.entry.description, a.category))
            .map((a) => ({ entry: a.entry, archive: a }))
        : [];
    return [...appItems, ...archiveItems].sort((x, y) => x.entry.label.localeCompare(y.entry.label));
  }, [apps, archives, activeCat, q]);

  const showRecents = activeCat === "all" && !q && recents.length > 0;
  const showNoteworthy = activeCat === "all";
  const filteredNoteworthy = showNoteworthy
    ? noteworthy.filter((a) => matches(q, a.name, a.description, ...(a.keywords ?? []))).slice(0, NOTEWORTHY_MAX)
    : [];

  const nothingMatches = gridItems.length === 0 && filteredNoteworthy.length === 0 && !showRecents;

  // Enter opens the top match while searching, in on-screen order.
  const firstMatchHref = q
    ? gridItems[0]?.entry.href ??
      (filteredNoteworthy[0] ? `/app-store/app/${filteredNoteworthy[0].id}` : undefined)
    : undefined;

  function openPath(href: string) {
    navigate(href);
    onClose();
  }

  function openStoreApp(app: StoreApp) {
    navigate(`/app-store/app/${app.id}`);
    onClose();
  }

  function pinToggle(entry: LauncherEntry) {
    if (!entry.pinnable) return undefined;
    return () => {
      if (pinnedSet.has(entry.id)) {
        onUnpin(entry.id);
        toast.info(`Removed ${entry.label} from Favorites`);
      } else {
        onPin(entry.id);
        toast.success(`Added ${entry.label} to Favorites`);
      }
    };
  }

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
          {/* Search, flush header matching SpotlightSearch */}
          <div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-5 py-4">
            <Search className="size-4 shrink-0 text-foreground/40" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && firstMatchHref) openPath(firstMatchHref);
              }}
              placeholder="Search apps and categories..."
              aria-label="Search apps"
              className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/30"
            />
            <kbd className="inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/25 leading-none">
              esc
            </kbd>
          </div>

          {/* Category chips: the App Store's categories */}
          <ChipRow className="shrink-0 px-4 pb-1 pt-3">
            <Chip label="All" active={activeCat === "all"} onClick={() => setActiveCat("all")} />
            {categories.map((c) => (
              <Chip key={c.key} label={c.name} active={activeCat === c.key} onClick={() => setActiveCat(c.key)} />
            ))}
          </ChipRow>

          {/* Grid: fixed height (not max-h) so the modal doesn't resize as
              chip/category filters change how much content is inside. The mobile
              sheet passes a flex-fill class instead. */}
          <div className={cn("overflow-y-auto px-4 pb-6 pt-3", scrollerClassName ?? "h-[min(65vh,40rem)]")}>
            {showRecents && (
              <section className="mb-4 border-b border-border/40 pb-4">
                <SectionHeading label="Recents" />
                <div className="no-scrollbar flex gap-1 overflow-x-auto">
                  {recents.map(({ entry, archive }) => (
                    <LaunchTile
                      key={entry.id}
                      entry={entry}
                      fixedWidth
                      iconNode={archive ? <ArchiveTileIcon zimIconUrl={archive.zimIconUrl} category={archive.category} /> : undefined}
                      pinned={pinnedSet.has(entry.id)}
                      onOpen={() => openPath(entry.href)}
                      onTogglePin={pinToggle(entry)}
                      onIntent={archive ? undefined : () => prefetch(entry.href)}
                      onHover={setHovered}
                    />
                  ))}
                </div>
              </section>
            )}

            {gridItems.length > 0 && (
              <div className={GRID_CLASS}>
                {gridItems.map(({ entry, archive }) => (
                  <LaunchTile
                    key={entry.id}
                    entry={entry}
                    iconNode={archive ? <ArchiveTileIcon zimIconUrl={archive.zimIconUrl} category={archive.category} /> : undefined}
                    pinned={pinnedSet.has(entry.id)}
                    onOpen={() => openPath(entry.href)}
                    onTogglePin={pinToggle(entry)}
                    onIntent={archive ? undefined : () => prefetch(entry.href)}
                    onHover={setHovered}
                  />
                ))}
              </div>
            )}

            {filteredNoteworthy.length > 0 && (
              <section className={cn(gridItems.length > 0 && "mt-4 border-t border-border/40 pt-4")}>
                <SectionHeading label="New & noteworthy" />
                <div className={GRID_CLASS}>
                  {filteredNoteworthy.map((a) => (
                    <LaunchTile
                      key={a.id}
                      entry={{ id: a.id, label: a.name, description: a.description, href: `/app-store/app/${a.id}` }}
                      iconNode={
                        <span className="flex size-14 shrink-0 items-center justify-center rounded-card border border-dashed border-border bg-muted/30">
                          <a.icon className="size-7 text-muted-foreground" />
                        </span>
                      }
                      onOpen={() => openStoreApp(a)}
                      onHover={setHovered}
                    />
                  ))}
                </div>
              </section>
            )}

            {nothingMatches && (
              <p className="px-2 py-10 text-center text-sm text-muted-foreground">
                Nothing matches "{query.trim()}"
              </p>
            )}
          </div>

          {/* Footer: live info bar for the hovered app + a persistent path to
              the full App Store. */}
          <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-t border-border/30 px-5">
            <p className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
              {hovered ? (
                <>
                  <span className="font-medium text-foreground">{hovered.label}</span>
                  {hovered.description && <span> · {hovered.description}</span>}
                </>
              ) : (
                <span className="text-muted-foreground/60">
                  {apps.length} apps · {categories.length} categories
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={() => openPath("/app-store")}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-control px-1.5 py-1 text-caption font-medium text-brand transition-colors",
                "hover:text-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              Browse App Store
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </button>
          </div>
    </div>
  );
}
