import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Pin, PinOff, Search, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { APP_GROUPS } from "@/lib/appCategories";
import { categoryVisual } from "@/lib/archiveCategories";
import { useInstalledTools, isAppVisible } from "@/hooks/useInstalledTools";
import { useAppFeatures } from "@/hooks/useAppFeatures";
import { useInstalledArchives } from "@/hooks/useInstalledArchives";
import { useStoreApps, type StoreApp } from "@/lib/store/useStoreApps";
import { useIntentPrefetch } from "@/lib/prefetch/useIntentPrefetch";
import { AppIconTile } from "@/components/shared/AppIconTile";
import { ArchiveIcon } from "@/components/shared/ArchiveIcon";

// Launchpad-style overlay opened from the sidebar's "Apps" entry. Browsing
// surface for everything launchable: recents, installed apps grouped by
// category, installed offline-library archives, plus a "New & noteworthy"
// discovery row of not-yet-installed App Store apps. Pin state is shared with
// the sidebar Favorites list via props (one useNavPreferences instance,
// owned by LeftSidebar).

interface LauncherEntry {
  /** Pin key: app id, or `read:<sourceId>` for archives. */
  id: string;
  label: string;
  description?: string;
  href: string;
  icon?: LucideIcon;
  gradient?: string;
  color?: string;
}

interface AppLauncherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pinnedIds: readonly string[];
  recentIds: readonly string[];
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
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
      className="flex size-12 shrink-0 items-center justify-center rounded-card"
      style={{ background: visual.gradient }}
    >
      <ArchiveIcon zimIconUrl={zimIconUrl} category={category} className="size-6" />
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
  fixedWidth,
}: {
  entry: LauncherEntry;
  /** Overrides the AppIconTile (archive favicons, dashed store tiles). */
  iconNode?: React.ReactNode;
  pinned?: boolean;
  onOpen: () => void;
  /** When set, a Pin/PinOff affordance appears on hover. */
  onTogglePin?: () => void;
  onIntent?: () => void;
  /** Fixed tile width for horizontal rows (recents). */
  fixedWidth?: boolean;
}) {
  return (
    <div className={cn("group/tile relative", fixedWidth && "w-24 shrink-0")}>
      <button
        type="button"
        onClick={onOpen}
        onPointerEnter={onIntent}
        onFocus={onIntent}
        title={entry.description}
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
            "bg-secondary/90 text-muted-foreground shadow-sm hover:text-foreground",
            "opacity-0 transition-opacity group-hover/tile:opacity-100",
            "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {pinned ? <PinOff className="size-3" aria-hidden="true" /> : <Pin className="size-3" aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

function SectionHeading({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between px-2">
      <h3 className="text-overline text-muted-foreground">{label}</h3>
      {action}
    </div>
  );
}

export function AppLauncher({ open, onOpenChange, pinnedIds, recentIds, onPin, onUnpin }: AppLauncherProps) {
  const navigate = useNavigate();
  const prefetch = useIntentPrefetch();
  const appFeatures = useAppFeatures();
  const { enabledToolIds } = useInstalledTools();
  const { data: installedArchives } = useInstalledArchives();
  const { apps: storeApps } = useStoreApps();
  const [query, setQuery] = useState("");

  // Fresh search each time the launcher opens.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const q = query.trim().toLowerCase();
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  // Installed apps grouped by catalog category, feature/tool filtered.
  const groups = useMemo(
    () =>
      APP_GROUPS.map((g) => ({
        key: g.key,
        name: g.name,
        apps: g.apps
          .filter(
            (a) =>
              (!a.feature || appFeatures[a.feature] !== false) &&
              isAppVisible(a.toolId, enabledToolIds),
          )
          .map(
            (a): LauncherEntry => ({
              id: a.id,
              label: a.label,
              description: a.description,
              href: a.to,
              icon: a.icon,
              gradient: a.gradient,
              color: a.color,
            }),
          ),
      })).filter((g) => g.apps.length > 0),
    [appFeatures, enabledToolIds],
  );

  const archives = useMemo(
    () =>
      (installedArchives ?? []).map((a) => ({
        entry: {
          id: `read:${a.sourceId}`,
          label: a.label ?? a.sourceId,
          description: a.description ?? undefined,
          href: `/read/${a.sourceId}`,
        } satisfies LauncherEntry,
        zimIconUrl: a.zimIconUrl ?? null,
        category: a.category ?? "Other",
      })),
    [installedArchives],
  );

  // Recents: `nav.recent_apps` keys resolved against installed apps + archives.
  const recents = useMemo(() => {
    const appById = new Map(groups.flatMap((g) => g.apps).map((a) => [a.id, a]));
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
  }, [recentIds, groups, archives]);

  // Not-yet-installed App Store apps (full apps only, not chat extensions).
  const noteworthy = useMemo(
    () => storeApps.filter((a) => a.enabled === false && a.offline === false),
    [storeApps],
  );

  const filteredRecents = recents.filter((r) => matches(q, r.entry.label, r.entry.description));
  const filteredGroups = groups
    .map((g) => ({ ...g, apps: g.apps.filter((a) => matches(q, a.label, a.description)) }))
    .filter((g) => g.apps.length > 0);
  const filteredArchives = archives.filter((a) => matches(q, a.entry.label, a.entry.description, a.category));
  const filteredNoteworthy = noteworthy
    .filter((a) => matches(q, a.name, a.description, ...(a.keywords ?? [])))
    .slice(0, NOTEWORTHY_MAX);

  const nothingMatches =
    filteredRecents.length === 0 &&
    filteredGroups.length === 0 &&
    filteredArchives.length === 0 &&
    filteredNoteworthy.length === 0;

  function openPath(href: string) {
    navigate(href);
    onOpenChange(false);
  }

  function openStoreApp(app: StoreApp) {
    navigate(`/app-store/app/${app.id}`);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[calc(100vw-2rem)] max-w-4xl gap-0 overflow-hidden p-0 rounded-sheet sm:rounded-sheet"
      >
        <DialogTitle className="sr-only">Apps</DialogTitle>

        {/* Search */}
        <div className="border-b border-border/50 p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search apps"
              aria-label="Search apps"
              className="h-10 rounded-full bg-secondary/50 pl-10 pr-4"
            />
          </div>
        </div>

        {/* Sections */}
        <div className="max-h-[min(70vh,44rem)] overflow-y-auto p-4 pb-6">
          {filteredRecents.length > 0 && (
            <section className="mb-6">
              <SectionHeading label="Recents" />
              <div className="no-scrollbar flex gap-1 overflow-x-auto">
                {filteredRecents.map(({ entry, archive }) => (
                  <LaunchTile
                    key={entry.id}
                    entry={entry}
                    fixedWidth
                    iconNode={archive ? <ArchiveTileIcon zimIconUrl={archive.zimIconUrl} category={archive.category} /> : undefined}
                    pinned={pinnedSet.has(entry.id)}
                    onOpen={() => openPath(entry.href)}
                    onTogglePin={() => (pinnedSet.has(entry.id) ? onUnpin(entry.id) : onPin(entry.id))}
                    onIntent={archive ? undefined : () => prefetch(entry.href)}
                  />
                ))}
              </div>
            </section>
          )}

          {filteredGroups.map((g) => (
            <section key={g.key} className="mb-6">
              <SectionHeading label={g.name} />
              <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
                {g.apps.map((a) => (
                  <LaunchTile
                    key={a.id}
                    entry={a}
                    pinned={pinnedSet.has(a.id)}
                    onOpen={() => openPath(a.href)}
                    onTogglePin={() => (pinnedSet.has(a.id) ? onUnpin(a.id) : onPin(a.id))}
                    onIntent={() => prefetch(a.href)}
                  />
                ))}
              </div>
            </section>
          ))}

          {filteredArchives.length > 0 && (
            <section className="mb-6">
              <SectionHeading label="Library" />
              <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
                {filteredArchives.map((a) => (
                  <LaunchTile
                    key={a.entry.id}
                    entry={a.entry}
                    iconNode={<ArchiveTileIcon zimIconUrl={a.zimIconUrl} category={a.category} />}
                    pinned={pinnedSet.has(a.entry.id)}
                    onOpen={() => openPath(a.entry.href)}
                    onTogglePin={() => (pinnedSet.has(a.entry.id) ? onUnpin(a.entry.id) : onPin(a.entry.id))}
                  />
                ))}
              </div>
            </section>
          )}

          {filteredNoteworthy.length > 0 && (
            <section className="mb-2">
              <SectionHeading
                label="New & noteworthy"
                action={
                  <button
                    type="button"
                    onClick={() => openPath("/app-store")}
                    className={cn(
                      "flex items-center gap-1 rounded-full px-1 text-caption text-brand transition-colors",
                      "hover:text-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    App Store
                    <ArrowRight className="size-3.5" aria-hidden="true" />
                  </button>
                }
              />
              <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
                {filteredNoteworthy.map((a) => (
                  <LaunchTile
                    key={a.id}
                    entry={{ id: a.id, label: a.name, description: a.description, href: `/app-store/app/${a.id}` }}
                    iconNode={
                      <span className="flex size-12 shrink-0 items-center justify-center rounded-card border border-dashed border-border bg-muted/30">
                        <a.icon className="size-6 text-muted-foreground" />
                      </span>
                    }
                    onOpen={() => openStoreApp(a)}
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
      </DialogContent>
    </Dialog>
  );
}
