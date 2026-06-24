import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Outlet } from "react-router-dom";
import {
  ExternalLink, Home, LayoutGrid, Loader2, Locate, Lock, MapPin, Search, Settings,
  ShieldCheck, ShoppingBag, Sparkles, Terminal, User, X,
  type LucideIcon,
} from "lucide-react";
import { AppBreadcrumb, type BreadcrumbCrumb } from "@/components/shared/AppBreadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBreadcrumbSearchConfig } from "@/context/BreadcrumbSearchContext";
import { useAuth } from "@/context/AuthContext";
import { AppIconTile } from "@/components/shared/AppIconTile";
import { getAppByPath, getGroupByAppPath, getAppGroup } from "@/lib/appCategories";
import { categoryVisual } from "@/lib/archiveCategories";
import { LeftSidebar } from "./LeftSidebar";
import { BottomTabBar } from "./BottomTabBar";
import { CompanionOverlay } from "./CompanionOverlay";
import { QueueBanner } from "./QueueBanner";
import { PodcastPlayerBar } from "@/components/podcast/PodcastPlayerBar";
import { YoutubeMiniBar } from "@/components/youtube/YoutubeMiniBar";
import { useChatContext } from "@/context/ChatContext";
import { useUserLocation } from "@/hooks/useUserLocation";
import { useNewsPrefetch } from "@/lib/news/useNews";

// Pages not in APP_GROUPS (no category group in the breadcrumb).
const STANDALONE_META: Record<string, { title: string; icon: LucideIcon; color: string; gradient?: string }> = {
  "/categories": { title: "Categories", icon: LayoutGrid,  color: "#6d28d9", gradient: "linear-gradient(135deg,#4c1d95,#c026d3)" },
  "/companions": { title: "Companions", icon: Sparkles,    color: "#f59e0b", gradient: "linear-gradient(135deg,#92400e,#f59e0b)" },
  "/app-store":  { title: "App Store",  icon: ShoppingBag, color: "#6366f1", gradient: "linear-gradient(135deg,#4338ca,#6366f1)" },
  "/me":         { title: "Me",         icon: User,        color: "#6b7280" },
  "/settings":   { title: "Settings",   icon: Settings,    color: "#6b7280" },
  "/admin":      { title: "Admin",      icon: ShieldCheck, color: "#dc2626" },
  "/devtools":   { title: "Dev Tools",  icon: Terminal,    color: "#6b7280" },
};

const PANEL_PREFIXES = ["/settings", "/admin", "/devtools"];

export function AppShell() {
  useNewsPrefetch();
  const { pathname } = useLocation();
  const isHome = pathname === "/";
  const isChat = pathname.startsWith("/chat");
  const isPanel = PANEL_PREFIXES.some(p => pathname.startsWith(p));
  // Full-bleed apps own their full height and let the companion float over them.
  // isReader (ZIM reader at /read/:id + docs) provides its OWN breadcrumb header, so the
  // standard one is suppressed there. NOTE: match "/read/" (trailing slash) so the Reader
  // app at "/bookmarks" is NOT caught — it uses the standard breadcrumb like other apps.
  const isReader = pathname.startsWith("/read/") || pathname.startsWith("/docs");
  const isFullBleed = pathname.startsWith("/maps") || isReader || pathname.startsWith("/imaging") || pathname.startsWith("/video") || pathname.startsWith("/youtube") || pathname.startsWith("/bookmarks");
  const { conversations, conversationId, currentProject } = useChatContext();
  const { user } = useAuth();
  const navigate = useNavigate();
  const breadcrumbSearch = useBreadcrumbSearchConfig();
  const { location, status, error: locationError, detect, setManual } = useUserLocation();
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [cityQuery, setCityQuery] = useState('');

  const showLocationBanner =
    (status === "ready" || status === "detecting" || status === "error") &&
    !location &&
    !bannerDismissed;

  // Registry lookup: APP_GROUPS first, then standalone pages.
  const appItem  = getAppByPath(pathname);
  const appGroup = appItem ? getGroupByAppPath(pathname) : null;
  const standaloneEntry = !appItem
    ? Object.entries(STANDALONE_META).find(([k]) => pathname.startsWith(k)) ?? null
    : null;
  const standaloneMeta = standaloneEntry?.[1] ?? null;

  // /category/:name pages — resolve visual from the app-group or archive-category registry.
  const isCategory = pathname.startsWith("/category/");
  const categorySlug = isCategory ? (pathname.split("/")[2] ?? "") : "";
  const categoryGroupMeta    = isCategory ? getAppGroup(categorySlug) : null;
  const categoryArchiveMeta  = isCategory ? categoryVisual(decodeURIComponent(categorySlug)) : null;
  // Root path for the current app — makes the last breadcrumb crumb clickable.
  const pageRootHref: string | undefined =
    appItem?.to ?? standaloneEntry?.[0] ?? (isCategory ? pathname : undefined);

  const pageTitle = isCategory
    ? decodeURIComponent(categorySlug || "Category")
    : appItem?.label ?? standaloneMeta?.title ?? null;

  const PageIcon: LucideIcon | null =
    appItem?.icon ??
    standaloneMeta?.icon ??
    categoryGroupMeta?.icon ??
    categoryArchiveMeta?.icon ??
    null;

  const pageColor: string | undefined =
    appItem?.color ??
    standaloneMeta?.color ??
    categoryGroupMeta?.color ??
    categoryArchiveMeta?.accent ??
    undefined;

  const pageGradient: string | undefined =
    appItem?.gradient ??
    standaloneMeta?.gradient ??
    categoryGroupMeta?.gradient ??
    categoryArchiveMeta?.gradient ??
    undefined;

  const activeConvTitle = isChat
    ? conversations.find((c) => c.id === conversationId)?.title ?? null
    : null;

  return (
    <div className="flex h-screen bg-background">

      {/* Fixed left sidebar */}
      <LeftSidebar />

      {/* Right column */}
      <div className="relative z-10 flex flex-1 min-w-0 flex-col">

        {/* Queue position banner — shown when waiting for a generation slot */}
        <QueueBanner />

        {/* Location banner */}
        {showLocationBanner && (
          <div className="shrink-0 flex items-start gap-3 border-b border-border/40 bg-muted/40 px-4 py-2">
            <MapPin className="size-3.5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0 space-y-1.5">
              {locationError ? (
                <>
                  <p className="text-xs text-amber-600 dark:text-amber-400">{locationError}</p>
                  <form
                    className="flex gap-1.5"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!cityQuery.trim()) return;
                      await setManual(cityQuery.trim());
                      setCityQuery('');
                    }}
                  >
                    <input
                      value={cityQuery}
                      onChange={e => setCityQuery(e.target.value)}
                      placeholder="Type your city…"
                      className="h-7 flex-1 min-w-0 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <button
                      type="submit"
                      disabled={!cityQuery.trim() || status === "detecting"}
                      className="flex items-center gap-1 rounded-md bg-foreground/10 hover:bg-foreground/15 disabled:opacity-40 px-2 py-1 text-xs font-medium transition-colors shrink-0"
                    >
                      <Search className="size-3" />
                      Set
                    </button>
                    <button
                      type="button"
                      onClick={detect}
                      disabled={status === "detecting"}
                      className="flex items-center gap-1 rounded-md bg-foreground/5 hover:bg-foreground/10 disabled:opacity-40 px-2 py-1 text-xs text-muted-foreground transition-colors shrink-0"
                    >
                      {status === "detecting" ? <Loader2 className="size-3 animate-spin" /> : <Locate className="size-3" />}
                      Retry
                    </button>
                  </form>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Allow location access for weather, moon phase, and local info.
                </p>
              )}
            </div>
            {status !== "detecting" && !locationError && (
              <button
                onClick={detect}
                className="flex items-center gap-1 rounded-md bg-foreground/10 hover:bg-foreground/15 px-2.5 py-1 text-xs font-medium transition-colors shrink-0"
              >
                <Locate className="size-3" />
                Allow
              </button>
            )}
            {status === "detecting" && !locationError && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground shrink-0 mt-0.5" />
            )}
            <button
              onClick={() => setBannerDismissed(true)}
              className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {/* Breadcrumb — the reader provides its own header, so suppress it there. */}
        {!isHome && pageTitle && !isReader && (
          <AppBreadcrumb crumbs={(() => {
            const home: BreadcrumbCrumb = { label: "Home", href: "/", icon: Home };
            // Non-last crumbs: plain muted icon only (no color, no tile).
            const groupCrumb: BreadcrumbCrumb | null = appGroup
              ? { label: appGroup.name, href: "/category/" + appGroup.key, icon: appGroup.icon }
              : null;
            // Last crumb: filled tile if gradient available, else colored icon, else plain.
            const lastIconProps = (icon: LucideIcon | null): Partial<BreadcrumbCrumb> => {
              if (icon && pageGradient) return { iconNode: <AppIconTile icon={icon} gradient={pageGradient} /> };
              if (icon && pageColor)    return { icon, iconStyle: { color: pageColor } };
              if (icon)                 return { icon };
              return {};
            };
            const chatHasDeeper = isChat && (currentProject || activeConvTitle);
            if (chatHasDeeper) {
              return [
                home,
                ...(groupCrumb ? [groupCrumb] : []),
                { label: pageTitle, href: "/chat", icon: PageIcon ?? undefined },
                ...(currentProject ? [{ label: currentProject.name } as BreadcrumbCrumb] : []),
                ...(activeConvTitle ? [{ label: activeConvTitle, truncate: true } as BreadcrumbCrumb] : []),
              ];
            }
            return [home, ...(groupCrumb ? [groupCrumb] : []), { label: pageTitle, href: pageRootHref, ...lastIconProps(PageIcon) }];
          })()}>
            {breadcrumbSearch && (
              <>
                {breadcrumbSearch.leftSlot}
                <form
                  onSubmit={(e) => { e.preventDefault(); breadcrumbSearch.onSubmit?.() }}
                  className="flex flex-1 gap-1"
                >
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={breadcrumbSearch.query}
                      onChange={(e) => breadcrumbSearch.setQuery(e.target.value)}
                      placeholder={breadcrumbSearch.placeholder ?? 'Search...'}
                      className="h-8 pl-8 text-sm"
                    />
                  </div>
                  {breadcrumbSearch.onSubmit && (
                    <Button type="submit" size="sm" variant="secondary" className="h-8 px-3">
                      {breadcrumbSearch.loading
                        ? <Loader2 className="size-3.5 animate-spin" />
                        : 'Search'
                      }
                    </Button>
                  )}
                </form>
                {breadcrumbSearch.rightSlot}
                {breadcrumbSearch.settingsHref && user?.role === 'admin' && (
                  <Button
                    variant="ghost" size="icon" className="relative size-8 shrink-0"
                    title="Admin settings"
                    onClick={() => navigate(breadcrumbSearch.settingsHref!)}
                  >
                    <Settings className="size-4" />
                    <Lock className="absolute right-1 top-1 size-2.5 text-amber-500" />
                  </Button>
                )}
                {breadcrumbSearch.externalHref && (
                  <a href={breadcrumbSearch.externalHref} target="_blank" rel="noopener noreferrer" title="Open website">
                    <Button variant="ghost" size="icon" className="size-8 shrink-0" asChild>
                      <span><ExternalLink className="size-4" /></span>
                    </Button>
                  </a>
                )}
              </>
            )}
          </AppBreadcrumb>
        )}

        {/* Content. Full-bleed apps (chat, panels, maps) fill the whole height
            and let the floating companion overlay them. Other scrollers get
            bottom padding so the companion bar doesn't occlude the last row. */}
        {isChat || isPanel || isFullBleed ? (
          <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
            <Outlet />
          </div>
        ) : (
          <div id="main-scroll" className="flex-1 overflow-y-auto pb-28 md:pb-32">
            <Outlet />
          </div>
        )}

        {/* Persistent media player bars — shown above companion when a track is loaded */}
        <YoutubeMiniBar />
        <PodcastPlayerBar />

        {/* Bottom tab bar — mobile only (hosts the companion at its center) */}
        <BottomTabBar />
      </div>

      {/* Floating companion — the global input + persistent animated buddy (desktop).
          Lives OUTSIDE the right column so its z-[9999] competes with the sidebar's
          stacking context directly; otherwise the column's own z-10 traps it and the
          dragged overlay slides under the sidebar. */}
      <CompanionOverlay />
    </div>
  );
}
