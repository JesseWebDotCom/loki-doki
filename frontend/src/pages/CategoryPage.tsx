import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import { usePublishUIContext } from "@/context/UIContextProvider";
import { getAppGroup, type AppItem } from "@/lib/appCategories";
import { useInstalledTools, isAppVisible } from "@/hooks/useInstalledTools";
import { PageShell } from "@/components/shared/PageShell";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageContainer } from "@/components/shared/PageContainer";

// ── App card ──────────────────────────────────────────────────────────────────

function AppCard({ app }: { app: AppItem }) {
  const Icon = app.icon;
  return (
    <Link
      to={app.to}
      className="group relative overflow-hidden rounded-card border border-border/40 bg-card/60 p-4 shimmer-sweep transition-all hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98]"
    >
      <div
        className="relative mb-3 flex size-12 items-center justify-center rounded-control shadow-lg transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-hover:scale-110 group-hover:rotate-6"
        style={{ background: app.gradient }}
      >
        <Icon className="size-6 text-white drop-shadow-sm" />
      </div>
      <p className="relative text-[15px] font-bold leading-tight tracking-tight">{app.label}</p>
      <p className="relative mt-1 text-[11px] leading-snug text-muted-foreground">{app.description}</p>
    </Link>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function CategoryPage() {
  const { category: rawCategory } = useParams<{ category: string }>();
  const categoryKey = decodeURIComponent(rawCategory ?? "").toLowerCase();

  const appGroup = getAppGroup(categoryKey);

  const [appFeatures, setAppFeatures] = useState<Record<string, boolean>>({});
  const { enabledToolIds } = useInstalledTools();

  useEffect(() => {
    if (!appGroup) return;
    fetch("/api/app-features", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setAppFeatures(d as Record<string, boolean>))
      .catch(() => {});
  }, [appGroup]);

  const visibleApps = useMemo(
    () =>
      appGroup?.apps.filter(
        (a) =>
          (!a.feature || appFeatures[a.feature] !== false) &&
          isAppVisible(a.toolId, enabledToolIds),
      ) ?? [],
    [appGroup, appFeatures, enabledToolIds],
  );

  const displayName = appGroup?.name ?? (categoryKey.charAt(0).toUpperCase() + categoryKey.slice(1));
  // design-ok(hex-in-tsx): neutral slate fallback when a category slug has no app-group gradient
  const gradient = appGroup?.gradient ?? "linear-gradient(135deg,#475569,#334155)";
  const HeaderIcon = appGroup?.icon;

  usePublishUIContext({
    label: displayName,
    description: `User is browsing the "${displayName}" category (${visibleApps.length} ${visibleApps.length === 1 ? "app" : "apps"}).`,
  });

  return (
    <PageShell gradient={gradient} GhostIcon={HeaderIcon}>
      <PageContainer className="pb-10">
        <PageHeader
          title={displayName}
          subtitle={`${visibleApps.length} ${visibleApps.length === 1 ? "app" : "apps"}`}
          gradient={gradient}
          icon={HeaderIcon}
        />

        {visibleApps.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {visibleApps.map((app) => <AppCard key={app.id} app={app} />)}
          </div>
        ) : (
          <Link
            to="/app-store"
            className="group flex items-center gap-4 rounded-card border-2 border-dashed border-border/50 bg-card/40 px-5 py-5 transition-colors hover:border-brand/40 hover:bg-card"
          >
            <div className="flex size-12 shrink-0 items-center justify-center rounded-card bg-brand/10 text-brand">
              <Plus className="size-6" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Nothing here yet</p>
              <p className="text-sm text-muted-foreground">Browse the App Store to add more.</p>
            </div>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </Link>
        )}
      </PageContainer>
    </PageShell>
  );
}
