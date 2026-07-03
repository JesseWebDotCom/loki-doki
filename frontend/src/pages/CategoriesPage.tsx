import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Plus, type LucideIcon } from "lucide-react";
import { usePublishUIContext } from "@/context/UIContextProvider";
import { categoryVisual, compareCategories, formatBytes } from "@/lib/archiveCategories";
import { APP_GROUPS } from "@/lib/appCategories";
import { useInstalledTools, isAppVisible } from "@/hooks/useInstalledTools";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageContainer } from "@/components/shared/PageContainer";
import { SectionHeader } from "@/components/shared/SectionHeader";


// ── Shared gradient card ──────────────────────────────────────────────────────

function GradientCard({
  to,
  gradient,
  icon: Icon,
  label,
  meta,
}: {
  to: string;
  gradient: string;
  icon: LucideIcon;
  label: string;
  meta: string;
}) {
  return (
    <Link
      to={to}
      className="group relative flex h-24 flex-col justify-between overflow-hidden rounded-card p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98]"
      style={{ background: gradient }}
    >
      <div className="flex size-8 items-center justify-center rounded-control bg-white/15 ring-1 ring-white/20">
        <Icon className="size-4 text-white" />
      </div>
      <div>
        <p className="text-sm font-bold text-white leading-tight">{label}</p>
        <p className="text-[11px] text-white/60 leading-tight">{meta}</p>
      </div>
      <ChevronRight className="absolute right-2.5 top-3 size-3.5 text-white/40 transition-transform group-hover:translate-x-0.5" />
      {/* design-ok(glass-on-plain-bg): decorative glow sits over the app gradient, not a plain background */}
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

interface CategorySummary {
  category: string;
  count: number;
  totalBytes: number;
}

export function CategoriesPage() {
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
    let cancelled = false;
    fetch("/api/app-features", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setAppFeatures(d as Record<string, boolean>); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const appGroups = useMemo(
    () =>
      APP_GROUPS.map((g) => ({
        ...g,
        visibleCount: g.apps.filter(
          (a) =>
            (!a.feature || appFeatures[a.feature] !== false) &&
            isAppVisible(a.toolId, enabledToolIds),
        ).length,
      })),
    [appFeatures, enabledToolIds],
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

  const totalApps = appGroups.reduce((s, g) => s + g.visibleCount, 0);

  usePublishUIContext({
    label: "Categories",
    description: `User is browsing all apps and library categories (${totalApps} apps, ${categories.length} library categories).`,
  });

  return (
    <div className="min-h-full bg-background">
      <PageContainer className="pb-10">
      <PageHeader
        eyebrow="Browse"
        title="Categories"
        subtitle="Apps and your offline library, all in one place."
      />

      {/* App categories */}
      <div className="pt-2">
        <div className="mb-3">
          <SectionHeader title="Apps" count={totalApps} />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {appGroups.map((g) => (
            <GradientCard
              key={g.key}
              to={`/category/${g.key}`}
              gradient={g.gradient}
              icon={g.icon}
              label={g.name}
              meta={`${g.visibleCount} ${g.visibleCount === 1 ? "app" : "apps"}`}
            />
          ))}
        </div>
      </div>

      {/* Offline library */}
      <div className="mt-8">
        <div className="mb-3">
          <SectionHeader title="Offline Library" />
        </div>
        {categories.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {categories.map((c) => {
              const v = categoryVisual(c.category);
              return (
                <GradientCard
                  key={c.category}
                  to={`/category/${encodeURIComponent(c.category)}`}
                  gradient={v.gradient}
                  icon={v.icon}
                  label={c.category}
                  meta={`${c.count} ${c.count === 1 ? "library" : "libraries"}${formatBytes(c.totalBytes) ? ` · ${formatBytes(c.totalBytes)}` : ""}`}
                />
              );
            })}
          </div>
        ) : (
          <Link
            to="/admin/features"
            className="group flex items-center gap-4 rounded-card border-2 border-dashed border-border/50 bg-card/40 px-5 py-5 transition-colors hover:border-brand/40 hover:bg-card"
          >
            <div className="flex size-12 shrink-0 items-center justify-center rounded-card bg-brand/10 text-brand">
              <Plus className="size-6" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Build your offline library</p>
              <p className="text-sm text-muted-foreground">
                Add Wikipedia, iFixit, medical & survival guides from Admin → Features.
              </p>
            </div>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </Link>
        )}
      </div>
      </PageContainer>
    </div>
  );
}
