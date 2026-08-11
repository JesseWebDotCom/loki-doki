import { Suspense, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Outlet } from "react-router-dom";
import {
  ExternalLink, Home, LayoutGrid, Locate, MapPin, Search, Settings,
  ShieldCheck, ShoppingBag, Terminal, User, X,
  type LucideIcon,
} from "lucide-react";
import { AppBreadcrumb, type BreadcrumbCrumb } from "@/components/shared/AppBreadcrumb";
import { PlexConnectBanner } from "@/components/media/PlexConnectBanner";
import { AppBackdrop } from "@/components/shared/AppBackdrop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { SmartSearchInput } from "@/components/shared/SmartSearchInput";
import { useAppHeaderConfig } from "@/context/BreadcrumbSearchContext";
import { classifyRoute } from "@/lib/routeChrome";
import { AppIconTile } from "@/components/shared/AppIconTile";
import { getAppByPath, getGroupByAppPath, getAppGroup } from "@/lib/appCategories";
import { categoryVisual } from "@/lib/archiveCategories";
import { LeftSidebar } from "./LeftSidebar";
import { MobileDock } from "./MobileDock";
import { MobileTopBar } from "./MobileTopBar";
import { CompanionEngineProvider } from "./CompanionEngineContext";
import { NavPreferencesProvider } from "@/context/NavPreferencesContext";
import { SpotlightSearch } from "@/components/shared/SpotlightSearch";
import { QueueBanner } from "./QueueBanner";
import { MediaBarSlot } from "./MediaBarSlot";
import { NowPlayingOverlay } from "@/components/music/NowPlayingOverlay";
import { ImmersivePlayerMount } from "@/components/music/ImmersivePlayer";
import { useBottomChrome } from "@/hooks/useBottomChrome";
import { ArtifactPane } from "@/components/canvas/ArtifactPane";
import { useArtifactState } from "@/lib/canvas/artifactStore";
import { useChatContext } from "@/context/ChatContext";
import { useUserLocation } from "@/hooks/useUserLocation";
import { useAppWarmer } from "@/lib/prefetch/useAppWarmer";
import { useLazyImageWarmer } from "@/lib/prefetch/useLazyImageWarmer";
import { useBrowserSession } from "@/hooks/useBrowserSession";
import { useDropReceiver } from "@/hooks/useDropReceiver";

// Pages not in APP_GROUPS (no category group in the breadcrumb).
// design-ok(hex-in-tsx): route identity registry data, mirrors getAppByPath() fallback precedent
const STANDALONE_META: Record<string, { title: string; icon: LucideIcon; color: string; gradient?: string }> = {
  "/categories": { title: "Categories", icon: LayoutGrid,  color: "#6d28d9", gradient: "linear-gradient(135deg,#4c1d95,#c026d3)" },
  "/app-store":  { title: "App Store",  icon: ShoppingBag, color: "#6366f1", gradient: "linear-gradient(135deg,#4338ca,#6366f1)" },
  "/me":         { title: "Me",         icon: User,        color: "#6b7280" },
  "/settings":   { title: "Settings",   icon: Settings,    color: "#6b7280" },
  "/admin":      { title: "Admin",      icon: ShieldCheck, color: "#dc2626" },
  // design-ok(hex-in-tsx): route identity registry data, mirrors getAppByPath() fallback precedent
  "/devtools":   { title: "Dev Tools",  icon: Terminal,    color: "#6b7280" },
};

// Scoped to the content pane (not the whole screen) so a lazy route chunk loading
// on a fresh page load only blanks the content area; the sidebar/breadcrumb chrome
// around it stays mounted the whole time instead of flashing away and back.
function PageLoading() {
  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center">
      <Spinner size="lg" className="size-8" />
    </div>
  );
}

export function AppShell() {
  // Smart caching: warm pinned + recent apps' data during idle time so they open instantly.
  useAppWarmer();
  // Warm every deferred <img> on whatever page is open, so card art is already cached by
  // the time you scroll to it instead of starting its request as the card appears.
  useLazyImageWarmer();
  // Controller / Tab5 button commands over SSE.
  useBrowserSession();
  // Device-to-device Drop: receive files/links pushed from another of your devices.
  useDropReceiver();
  const { pathname } = useLocation();
  // Full-bleed apps own their full height and let the companion float over them.
  // isReader (ZIM reader at /read/:id + docs) provides its OWN breadcrumb header, so the
  // standard one is suppressed there. shellBackdrop is true for standard scroller apps,
  // which is where the shell paints the registry color/gradient tint.
  const { isHome, isChat, isPanel, isReader, isFullBleed, shellBackdrop } = classifyRoute(pathname);
  // Any settings surface (/apps/:id/settings, /weather/settings, /settings); the gear
  // in the breadcrumb doubles as the close toggle there (matches MobileTopBar).
  const onSettingsPage = /\/settings(\/|$)/.test(pathname);
  const { conversations, conversationId, currentProject } = useChatContext();
  // When the Canvas pane is open, inset the whole content column on desktop so chat
  // (and any app) reflows BESIDE the pane rather than being covered by it. Mobile
  // keeps the pane as a full-screen overlay (no room to split), so no inset there.
  const { paneOpen: canvasOpen } = useArtifactState();
  const navigate = useNavigate();
  const breadcrumbSearch = useAppHeaderConfig();
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Bumped when the user clicks the app crumb; remounts the Outlet to "reload" the app.
  const [reloadNonce, setReloadNonce] = useState(0);
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
  // Root path for the current app — the app crumb navigates here AND reloads the app.
  const pageRootHref: string | undefined =
    appItem?.to ?? standaloneEntry?.[0] ?? (isCategory ? pathname : undefined);

  // Clicking the app icon+name "reloads" the app: navigate to its root and remount the
  // Outlet (resets internal tab/scroll/search/query state). Keyed by app root so layout
  // apps keep their rail/player mounted during normal internal navigation.
  const reloadApp = () => {
    if (pageRootHref) navigate(pageRootHref);
    setReloadNonce(n => n + 1);
  };
  const appReloadKey = `${pageRootHref ?? pathname}#${reloadNonce}`;

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
    <NavPreferencesProvider>
    <CompanionEngineProvider>
    {/* One shared Spotlight dialog for the whole shell, opened from the sidebar row,
        the mobile top bar, and the home hero (single instance = single Cmd/Ctrl+K). */}
    <SpotlightSearch />
    <div className="flex h-screen bg-background">

      {/* Fixed left sidebar */}
      <LeftSidebar />

      {/* Right column: inset by the Canvas pane's width on desktop when it's open,
          but only on the Chat app, which is the only place the pane renders. */}
      {/* pt-safe: the shell owns the top safe area (status bar / notch) so pages never
          render under it; the inset is 0 on desktop (see agents.md > Mobile Design
          Contract). Fixed full-screen overlays escape this and pad themselves. */}
      <div className={`relative z-10 flex flex-1 min-w-0 flex-col pt-safe transition-[padding] duration-200 ${canvasOpen && isChat ? "md:pr-[32rem] lg:pr-[40rem]" : ""}`}>

        {/* Queue position banner — shown when waiting for a generation slot */}
        <QueueBanner />

        {/* Location banner */}
        {showLocationBanner && (
          <div className="shrink-0 flex items-start gap-3 border-b border-border/40 bg-muted/40 px-4 py-2">
            <MapPin className="size-3.5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0 space-y-1.5">
              {locationError ? (
                <>
                  <p className="text-xs text-warning">{locationError}</p>
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
                      className="h-7 flex-1 min-w-0 rounded-control border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      variant="tinted"
                      disabled={!cityQuery.trim() || status === "detecting"}
                      className="h-7 px-2 text-xs shrink-0"
                    >
                      <Search className="size-3" />
                      Set
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={detect}
                      disabled={status === "detecting"}
                      className="h-7 px-2 text-xs text-muted-foreground shrink-0"
                    >
                      {status === "detecting" ? <Spinner size="sm" className="size-3" /> : <Locate className="size-3" />}
                      Retry
                    </Button>
                  </form>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Allow location access for weather, moon phase, and local info.
                </p>
              )}
            </div>
            {status !== "detecting" && !locationError && (
              <Button
                size="sm"
                variant="tinted"
                onClick={detect}
                className="h-7 px-2.5 text-xs shrink-0"
              >
                <Locate className="size-3" />
                Allow
              </Button>
            )}
            {status === "detecting" && !locationError && (
              <Spinner size="sm" className="size-3.5 shrink-0 mt-0.5" />
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

        {/* Mobile top bar: the phone-only replacement for the breadcrumb (app identity +
            search + actions + rail drawer). Same guard as the breadcrumb below. */}
        {!isHome && pageTitle && !isReader && (
          <MobileTopBar
            title={pageTitle}
            icon={PageIcon}
            gradient={pageGradient}
            color={pageColor}
            onReload={reloadApp}
            config={breadcrumbSearch}
          />
        )}

        {/* Breadcrumb — the reader provides its own header, so suppress it there. Desktop
            only; phones use MobileTopBar above. */}
        {!isHome && pageTitle && !isReader && (
          <div className="hidden md:block">
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
                { label: pageTitle, onClick: reloadApp, icon: PageIcon ?? undefined },
                ...(currentProject ? [{ label: currentProject.name } as BreadcrumbCrumb] : []),
                ...(activeConvTitle ? [{ label: activeConvTitle, truncate: true } as BreadcrumbCrumb] : []),
              ];
            }
            // Panel pages (Admin, Settings) publish their live section/subsection state
            // as extra crumbs via useAppHeader instead of building their own local
            // breadcrumb bar. This is the one and only breadcrumb in the app.
            const extraCrumbs = breadcrumbSearch?.extraCrumbs ?? [];
            if (extraCrumbs.length > 0) {
              return [
                home,
                ...(groupCrumb ? [groupCrumb] : []),
                { label: pageTitle, onClick: reloadApp, icon: PageIcon ?? undefined },
                ...extraCrumbs.map((c): BreadcrumbCrumb => ({ label: c.label, onClick: c.onClick })),
              ];
            }
            return [home, ...(groupCrumb ? [groupCrumb] : []), { label: pageTitle, onClick: reloadApp, ...lastIconProps(PageIcon) }];
          })()}>
            {breadcrumbSearch && (
              <>
                {breadcrumbSearch.leftSlot}
                {breadcrumbSearch.searchable !== false ? (
                  <form
                    onSubmit={(e) => { e.preventDefault(); breadcrumbSearch.onSubmit?.() }}
                    className="flex flex-1 gap-1"
                  >
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      {breadcrumbSearch.suggest ? (
                        <SmartSearchInput
                          inputRef={searchInputRef}
                          value={breadcrumbSearch.query}
                          onChange={breadcrumbSearch.setQuery}
                          onSubmit={(picked) => breadcrumbSearch.onSubmit?.(picked)}
                          onPick={breadcrumbSearch.onPickSuggestion}
                          suggest={breadcrumbSearch.suggest}
                          placeholder={breadcrumbSearch.placeholder ?? 'Search...'}
                          className="h-8 pl-8 text-sm"
                        />
                      ) : (
                        <Input
                          ref={searchInputRef}
                          value={breadcrumbSearch.query}
                          onChange={(e) => breadcrumbSearch.setQuery(e.target.value)}
                          placeholder={breadcrumbSearch.placeholder ?? 'Search...'}
                          className="h-8 pl-8 text-sm"
                        />
                      )}
                    </div>
                    {breadcrumbSearch.onSubmit && (
                      <Button type="submit" size="sm" variant="secondary" className="h-8 px-3">
                        {breadcrumbSearch.loading
                          ? <Spinner size="sm" className="size-3.5" />
                          : 'Search'
                        }
                      </Button>
                    )}
                  </form>
                ) : (
                  <div className="flex-1" />
                )}
                {breadcrumbSearch.rightSlot}
                {/* Toggle, same as MobileTopBar: lit + closes settings while on a settings page. */}
                {(breadcrumbSearch.settingsHref || onSettingsPage) && (
                  <Button
                    variant="ghost" size="icon"
                    className={`size-8 shrink-0 ${onSettingsPage ? "bg-brand/15 text-brand" : ""}`}
                    title={onSettingsPage ? "Close settings" : "Settings"}
                    onClick={() => {
                      if (!onSettingsPage) navigate(breadcrumbSearch.settingsHref!)
                      else if ((window.history.state?.idx ?? 0) > 0) navigate(-1)
                      else navigate("/")
                    }}
                  >
                    <Settings className="size-4" />
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
          </div>
        )}

        {/* Plex connect prompt — only in the Plex-relevant apps (Movies/Shows and their subpages),
            fixed under the breadcrumb until the user links. Not shown in unrelated apps. */}
        {(pathname.startsWith("/movies") || pathname.startsWith("/shows")) && <PlexConnectBanner />}

        {/* Content. Full-bleed apps (chat, panels, maps) fill the whole height
            and let the floating companion overlay them. Other scrollers get
            bottom padding so the companion bar doesn't occlude the last row.
            Standard scrollers get the app's registry color/gradient backdrop
            painted by the shell (PageShell stays a transparent pass-through there). */}
        {isChat || isPanel || isFullBleed ? (
          <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
            <Suspense fallback={<PageLoading />}>
              <Outlet key={appReloadKey} />
            </Suspense>
          </div>
        ) : (
          <div className="relative flex-1 min-h-0">
            {shellBackdrop && <AppBackdrop gradient={pageGradient} GhostIcon={PageIcon ?? undefined} />}
            <div id="main-scroll" className="relative z-10 h-full overflow-y-auto pb-[max(7rem,calc(var(--bottom-chrome,0px)+1.5rem))] md:pb-[max(8rem,calc(var(--bottom-chrome,0px)+2rem))]">
              <Suspense fallback={<PageLoading />}>
                <Outlet key={appReloadKey} />
              </Suspense>
            </div>
          </div>
        )}

        {/* Canvas artifact pane: chat-app only (hides when you switch apps) */}
        <ArtifactPane />

        {/* App-wide full-page music player, raised from the mini bar / rail / deep link
            (portalled to <body>, so it sits outside the measured chrome below) */}
        <NowPlayingOverlay />
        <ImmersivePlayerMount />

        {/* Bottom chrome: the ONE media bar (MediaBarSlot arbitrates) + the mobile tab
            bar. Measured into --bottom-chrome so scrollers/floating widgets clear it. */}
        <BottomChrome />
      </div>
    </div>
    </CompanionEngineProvider>
    </NavPreferencesProvider>
  );
}

// The in-flow bottom stack, wrapped so useBottomChrome can measure the real
// rendered height (media bar heights vary, the dock is mobile-only, and its
// pb-safe inset differs per device).
function BottomChrome() {
  const ref = useBottomChrome<HTMLDivElement>();
  return (
    <div ref={ref} className="shrink-0">
      <MediaBarSlot />
      <MobileDock />
    </div>
  );
}
