import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import { usePublishUIContext } from "@/context/UIContextProvider";
import { categoryVisual, formatBytes } from "@/lib/archiveCategories";
import { getAppGroup, type AppItem } from "@/lib/appCategories";
import { useInstalledTools, isAppVisible } from "@/hooks/useInstalledTools";
import { PageShell } from "@/components/shared/PageShell";
import { PageHeader } from "@/components/shared/PageHeader";
import { ArchiveIcon } from "@/components/shared/ArchiveIcon";

// ── Types ───────────────────────────────────────────────────────────────────

interface InstalledArchive {
  id: string;
  sourceId: string;
  label: string;
  description: string | null;
  category: string;
  zimIconUrl: string | null;
  variantLabel: string;
  fileSizeBytes: number | null;
}

// ── App card (for apps that live in this category) ────────────────────────────

function AppCard({ app }: { app: AppItem }) {
  const Icon = app.icon;
  return (
    <Link
      to={app.to}
      className="group relative overflow-hidden rounded-2xl border border-border/40 bg-card/60 p-4 shimmer-sweep transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/5 active:scale-[0.98]"
    >
      <div
        className="relative mb-3 flex size-12 items-center justify-center rounded-xl shadow-lg transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-hover:scale-110 group-hover:rotate-6"
        style={{ background: app.gradient }}
      >
        <Icon className="size-6 text-white drop-shadow-sm" />
      </div>
      <p className="relative text-[15px] font-bold leading-tight tracking-tight">{app.label}</p>
      <p className="relative mt-1 text-[11px] leading-snug text-muted-foreground">{app.description}</p>
    </Link>
  );
}

// ── Archive store card ────────────────────────────────────────────────────────

function StoreCard({ a }: { a: InstalledArchive }) {
  const visual = categoryVisual(a.category);

  return (
    <Link
      to={`/read/${a.sourceId}`}
      className="group relative overflow-hidden rounded-2xl border border-border/40 bg-card/60 p-4 shimmer-sweep transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/5 active:scale-[0.98]"
    >
      <div
        className="relative mb-3 flex size-12 items-center justify-center rounded-xl shadow-lg transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-hover:scale-110 group-hover:rotate-6"
        style={{ background: visual.gradient }}
      >
        <ArchiveIcon zimIconUrl={a.zimIconUrl} category={a.category} className="size-6" />
      </div>
      <p className="relative text-[15px] font-bold leading-tight tracking-tight">{a.label}</p>
      <p className="relative mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
        {a.description ?? "Offline library"}
      </p>
    </Link>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function CategoryPage() {
  const { category: rawCategory } = useParams<{ category: string }>();
  const categoryKey = decodeURIComponent(rawCategory ?? "").toLowerCase();

  const appGroup = getAppGroup(categoryKey);

  const [archives, setArchives] = useState<InstalledArchive[]>([]);
  const [appFeatures, setAppFeatures] = useState<Record<string, boolean>>({});
  const { enabledToolIds } = useInstalledTools();

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/archives/installed", { credentials: "include" })
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setArchives(d.archives ?? []); })
        .catch(() => {});
    };
    load();
    window.addEventListener("focus", load);
    return () => { cancelled = true; window.removeEventListener("focus", load); };
  }, []);

  useEffect(() => {
    if (!appGroup) return;
    fetch("/api/app-features", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setAppFeatures(d as Record<string, boolean>))
      .catch(() => {});
  }, [appGroup]);

  // Case-insensitive archive filtering
  const archiveItems = useMemo(
    () => archives.filter(a => a.category.toLowerCase() === categoryKey),
    [archives, categoryKey],
  );

  const visibleApps = useMemo(
    () =>
      appGroup?.apps.filter(
        (a) =>
          (!a.feature || appFeatures[a.feature] !== false) &&
          isAppVisible(a.toolId, enabledToolIds),
      ) ?? [],
    [appGroup, appFeatures, enabledToolIds],
  );

  const totalItems = visibleApps.length + archiveItems.length;

  // Derive display name and visual — prefer app group info, fall back to archive data
  const displayName = appGroup?.name
    ?? (archiveItems[0]?.category ?? categoryKey.charAt(0).toUpperCase() + categoryKey.slice(1));
  const visual = appGroup
    ? { gradient: appGroup.gradient, icon: appGroup.icon, accent: "#a855f7" }
    : categoryVisual(archiveItems[0]?.category ?? categoryKey);

  const totalSize = useMemo(
    () => formatBytes(archiveItems.reduce((sum, a) => sum + (a.fileSizeBytes ?? 0), 0)),
    [archiveItems],
  );

  usePublishUIContext({
    label: displayName,
    description: `User is browsing the "${displayName}" category (${totalItems} ${totalItems === 1 ? "item" : "items"}).`,
  });

  const headerSubtitle = [
    `${totalItems} ${totalItems === 1 ? "item" : "items"}`,
    ...(totalSize ? [totalSize] : []),
  ].join(" · ");
  const HeaderIcon = visual.icon;

  return (
    <PageShell gradient={visual.gradient} GhostIcon={visual.icon}>
      <PageHeader
        variant="compact"
        title={displayName}
        subtitle={headerSubtitle}
        gradient={visual.gradient}
        icon={<HeaderIcon className="size-7 text-white" />}
      />

      {/* All items in a single unified grid */}
      {totalItems > 0 && (
        <div className="mt-5 grid grid-cols-2 gap-3 px-4 sm:grid-cols-3 lg:grid-cols-4">
          {visibleApps.map(app => <AppCard key={app.id} app={app} />)}
          {archiveItems.map(a => <StoreCard key={a.id} a={a} />)}
        </div>
      )}

      {/* Empty state — only show if nothing at all */}
      {totalItems === 0 && (
        <div className="mt-5 px-4">
          <Link
            to="/admin/features"
            className="group flex items-center gap-4 rounded-2xl border-2 border-dashed border-border/50 bg-card/40 px-5 py-5 transition-colors hover:border-brand/40 hover:bg-card"
          >
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-brand/10 text-brand">
              <Plus className="size-6" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Nothing here yet</p>
              <p className="text-sm text-muted-foreground">Add offline libraries from Admin → Features.</p>
            </div>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      )}

      <div className="h-10" />
    </PageShell>
  );
}
