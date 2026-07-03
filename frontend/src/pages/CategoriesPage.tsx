import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { usePublishUIContext } from "@/context/UIContextProvider";
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

export function CategoriesPage() {
  const [appFeatures, setAppFeatures] = useState<Record<string, boolean>>({});
  const { enabledToolIds } = useInstalledTools();

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

  const totalApps = appGroups.reduce((s, g) => s + g.visibleCount, 0);

  usePublishUIContext({
    label: "Categories",
    description: `User is browsing all apps (${totalApps} apps).`,
  });

  return (
    <div className="min-h-full bg-background">
      <PageContainer className="pb-10">
        <PageHeader
          eyebrow="Browse"
          title="Categories"
          subtitle="Every app, organized."
        />

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
      </PageContainer>
    </div>
  );
}
