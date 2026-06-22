import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Plus, type LucideIcon } from "lucide-react";
import { usePublishUIContext } from "@/context/UIContextProvider";
import { categoryVisual, compareCategories, formatBytes } from "@/lib/archiveCategories";
import { APP_GROUPS, type AppItem } from "@/lib/appCategories";
import { useInstalledTools, isAppVisible } from "@/hooks/useInstalledTools";
import { PageHeader } from "@/components/shared/PageHeader";
import { SectionHeader } from "@/components/shared/SectionHeader";

const ALL_APPS: AppItem[] = APP_GROUPS.flatMap(g => g.apps);


// ── App tile ──────────────────────────────────────────────────────────────────

function AppTile({ app }: { app: AppItem }) {
  const Icon = app.icon;
  return (
    <Link
      to={app.to}
      className="group relative flex h-24 flex-col justify-between overflow-hidden rounded-xl p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
      style={{ background: app.gradient }}
    >
      <div className="flex size-8 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/20 backdrop-blur-sm">
        <Icon className="size-4 text-white" />
      </div>
      <div>
        <p className="text-sm font-bold text-white leading-tight">{app.label}</p>
        <p className="text-[11px] text-white/60 leading-tight">{app.description}</p>
      </div>
      <ChevronRight className="absolute right-2.5 top-3 size-3.5 text-white/40 transition-transform group-hover:translate-x-0.5" />
      <div className="pointer-events-none absolute -bottom-8 -right-6 size-24 rounded-full bg-white/10 blur-xl" />
    </Link>
  );
}

// ── Library category card ─────────────────────────────────────────────────────

interface CategorySummary {
  category: string;
  count: number;
  totalBytes: number;
}

function CategoryCard({ summary }: { summary: CategorySummary }) {
  const v = categoryVisual(summary.category);
  const size = formatBytes(summary.totalBytes);
  return (
    <Link
      to={`/category/${encodeURIComponent(summary.category)}`}
      className="group relative flex h-24 flex-col justify-between overflow-hidden rounded-xl p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
      style={{ background: v.gradient }}
    >
      <div className="flex size-8 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/20 backdrop-blur-sm">
        <v.icon className="size-4 text-white" />
      </div>
      <div>
        <p className="text-sm font-bold text-white leading-tight">{summary.category}</p>
        <p className="text-[11px] text-white/60 leading-tight">
          {summary.count} {summary.count === 1 ? "library" : "libraries"}
          {size ? ` · ${size}` : ""}
        </p>
      </div>
      <ChevronRight className="absolute right-2.5 top-3 size-3.5 text-white/40 transition-transform group-hover:translate-x-0.5" />
      <div className="pointer-events-none absolute -bottom-8 -right-6 size-24 rounded-full bg-white/10 blur-xl" />
    </Link>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

interface InstalledArchive {
  id: string;
  sourceId: string;
  category: string;
  fileSizeBytes: number | null;
}

export function AllAppsPage() {
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
    fetch("/api/app-features", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setAppFeatures(d as Record<string, boolean>))
      .catch(() => {});
  }, []);

  const visibleApps = ALL_APPS.filter(
    (a) =>
      (!a.feature || appFeatures[a.feature] !== false) &&
      isAppVisible(a.toolId, enabledToolIds),
  );

  const categories = useMemo<CategorySummary[]>(() => {
    const byCat = new Map<string, CategorySummary>();
    for (const a of archives) {
      const cur = byCat.get(a.category) ?? { category: a.category, count: 0, totalBytes: 0 };
      cur.count += 1;
      cur.totalBytes += a.fileSizeBytes ?? 0;
      byCat.set(a.category, cur);
    }
    return [...byCat.values()].sort((x, y) => compareCategories(x.category, y.category));
  }, [archives]);

  usePublishUIContext({
    label: "Apps",
    description: `User is on the All Apps screen (${visibleApps.length} apps, ${categories.length} library categories).`,
  });

  return (
    <div className="min-h-full bg-background">
      <PageHeader
        eyebrow="LokiDoki"
        title="All Apps"
        subtitle="Everything in one place."
      />

      {/* Apps grid */}
      <div className="px-4 pt-2 sm:px-5">
        <div className="mb-3">
          <SectionHeader title="Apps" />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {visibleApps.map((app) => (
            <AppTile key={app.id} app={app} />
          ))}
        </div>
      </div>

      {/* Offline library categories */}
      <div className="mt-8 px-4 sm:px-5">
        <div className="mb-3">
          <SectionHeader title="Offline Library" />
        </div>

        {categories.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {categories.map((c) => (
              <CategoryCard key={c.category} summary={c} />
            ))}
          </div>
        ) : (
          <Link
            to="/admin/features"
            className="group flex items-center gap-4 rounded-2xl border-2 border-dashed border-border/50 bg-card/40 px-5 py-5 transition-colors hover:border-brand/40 hover:bg-card"
          >
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-brand/10 text-brand">
              <Plus className="size-6" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Build your offline library</p>
              <p className="text-sm text-muted-foreground">
                Add Wikipedia, iFixit, medical & survival guides — all readable with no internet.
              </p>
            </div>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </Link>
        )}
      </div>

      <div className="h-10" />
    </div>
  );
}
