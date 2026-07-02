import { Link, useLocation, useNavigate } from "react-router-dom";
import { useGenerationContext } from "@/context/GenerationContext";
import { usePrivacy } from "@/context/PrivacyContext";
import { useBusyAppPaths } from "@/context/SetupProgressContext";
import {
  BookMarked,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Cloud,
  Home,
  Lightbulb,
  Map as MapIcon,
  MessageCircle,
  Newspaper,
  Package,
  Pin,
  PinOff,
  ShoppingBag,
  Sparkles,
  Settings,
  ShieldCheck,
  LogOut,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { cn } from "@/lib/cn";
import { ScrollFade } from "@/components/shared/ScrollFade";
import { categoryVisual } from "@/lib/archiveCategories";
import { APP_GROUPS, getAppByPath } from "@/lib/appCategories";
import { useInstalledTools, isAppVisible } from "@/hooks/useInstalledTools";
import { useAppFeatures } from "@/hooks/useAppFeatures";
import { useInstalledArchives } from "@/hooks/useInstalledArchives";
import { AppIconTile } from "@/components/shared/AppIconTile";
import { ArchiveIcon } from "@/components/shared/ArchiveIcon";
import { BrandMark } from "@/components/shared/BrandMark";
import { useAuth } from "@/context/AuthContext";
import { SpotlightSearch } from "@/components/shared/SpotlightSearch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SortableNavItem } from "./SortableNavItem";
import { useNavPreferences } from "@/hooks/useNavPreferences";
import { useIntentPrefetch } from "@/lib/prefetch/useIntentPrefetch";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { useConnectivity } from "@/hooks/useConnectivity";
import { useNotifications } from "@/hooks/useNotifications";
import { notifIcon, notifLabel, timeAgo } from "@/lib/notifications";
import { toast } from "@/lib/toast";

interface AppEntry {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  gradient?: string;
  feature?: string;
}

const ALL_APPS: AppEntry[] = APP_GROUPS.flatMap(g =>
  g.apps.map(a => ({ id: a.id, label: a.label, href: a.to, icon: a.icon, gradient: a.gradient, feature: a.feature }))
);

function SectionHeading({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-center px-3 pt-3 pb-0.5 select-none">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 flex-1">
        {label}
      </p>
      {count !== undefined && (
        <span className="text-[10px] tabular-nums text-muted-foreground/40">{count}</span>
      )}
    </div>
  );
}

function NavIconLink({
  href,
  icon: Icon,
  label,
  exact,
  badge,
  gradient,
  onIntent,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
  badge?: 'busy' | 'done' | null;
  gradient?: string;
  onIntent?: () => void;
}) {
  const { pathname } = useLocation();
  const active = exact ? pathname === href : pathname.startsWith(href);

  return (
    <div className="group/tip relative flex justify-center">
      <Link
        to={href}
        onPointerEnter={onIntent}
        onFocus={onIntent}
        className={cn(
          "relative flex size-10 items-center justify-center rounded-lg transition-colors",
          active
            ? "bg-brand/10"
            : "hover:bg-foreground/5",
          !gradient && (active ? "text-brand" : "text-muted-foreground hover:text-foreground"),
        )}
      >
        {gradient
          ? <AppIconTile icon={Icon} gradient={gradient} />
          : <Icon className="size-4" />}
        {badge && (
          <span className={cn(
            "absolute top-1.5 right-1.5 size-1.5 rounded-full",
            badge === 'busy' ? "bg-blue-500 animate-pulse" : "bg-emerald-500",
          )} />
        )}
      </Link>
      <span className="pointer-events-none absolute left-full top-1/2 ml-3 -translate-y-1/2 z-50 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md ring-1 ring-border/20 opacity-0 group-hover/tip:opacity-100 transition-opacity duration-100 delay-300">
        {label}
      </span>
    </div>
  );
}

function NavWideLink({
  href,
  icon: Icon,
  label,
  exact,
  badge,
  gradient,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
  badge?: 'busy' | 'done' | null;
  gradient?: string;
}) {
  const { pathname } = useLocation();
  const active = exact ? pathname === href : pathname.startsWith(href);
  return (
    <Link
      to={href}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
        active
          ? "bg-brand/10 font-semibold"
          : "hover:bg-foreground/5",
        !gradient && (active ? "text-brand" : "text-muted-foreground hover:text-foreground"),
        gradient && (active ? "text-foreground" : "text-muted-foreground hover:text-foreground"),
      )}
    >
      {gradient
        ? <AppIconTile icon={Icon} gradient={gradient} />
        : <Icon className="size-4 shrink-0" />}
      <span className="flex-1 truncate">{label}</span>
      {badge && (
        <span className={cn(
          "size-1.5 rounded-full shrink-0",
          badge === 'busy' ? "bg-blue-500 animate-pulse" : "bg-emerald-500",
        )} />
      )}
    </Link>
  );
}

function NavItemWithPin({
  app,
  pinned,
  onPin,
  onUnpin,
  badge,
  onIntent,
}: {
  app: AppEntry;
  pinned: boolean;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  badge?: 'busy' | 'done' | null;
  onIntent?: () => void;
}) {
  const { pathname } = useLocation();
  const active = pathname === app.href || pathname.startsWith(app.href + "/");
  return (
    <div className="relative flex group/item w-full items-center py-0.5">
      <Link
        to={app.href}
        onPointerEnter={onIntent}
        onFocus={onIntent}
        className={cn(
          "flex flex-1 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
          active
            ? "bg-brand/10 text-brand font-semibold"
            : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        )}
      >
        {app.gradient
          ? <AppIconTile icon={app.icon} gradient={app.gradient} />
          : <app.icon className="size-4 shrink-0" />}
        <span className="flex-1 truncate">{app.label}</span>
        {badge && (
          <span className={cn(
            "size-1.5 rounded-full shrink-0",
            badge === 'busy' ? "bg-blue-500 animate-pulse" : "bg-emerald-500",
          )} />
        )}
      </Link>
      <button
        type="button"
        onClick={() => (pinned ? onUnpin(app.id) : onPin(app.id))}
        aria-label={pinned ? `Unpin ${app.label}` : `Pin ${app.label}`}
        className="absolute right-1 shrink-0 p-1 rounded opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-foreground transition-opacity focus-visible:opacity-100 focus-visible:outline-none"
      >
        {pinned ? (
          <PinOff className="size-3.5" aria-hidden="true" />
        ) : (
          <Pin className="size-3.5" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

// A recently-opened offline-library archive (the app-store "apps"). Resolved from
// a `read:<sourceId>` recent key + the installed-archives list.
interface RecentArchive {
  sourceId: string;
  label: string;
  href: string;
  zimIconUrl: string | null;
  category: string;
}

type RecentEntry =
  | { kind: "app"; app: AppEntry }
  | { kind: "archive"; archive: RecentArchive };

type PinnedEntry =
  | { id: string; kind: "app"; app: AppEntry }
  | { id: string; kind: "archive"; archive: RecentArchive };

function ArchiveFavicon({ archive }: { archive: RecentArchive }) {
  const visual = categoryVisual(archive.category);
  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center rounded-md"
      style={{ background: visual.gradient }}
    >
      <ArchiveIcon zimIconUrl={archive.zimIconUrl} category={archive.category} />
    </span>
  );
}

function ArchiveRecentRow({ archive, onPin }: { archive: RecentArchive; onPin: (id: string) => void }) {
  const { pathname } = useLocation();
  const active = pathname === archive.href;
  return (
    <div className="relative flex group/item w-full items-center py-0.5">
      <Link
        to={archive.href}
        className={cn(
          "flex flex-1 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
          active
            ? "bg-brand/10 text-brand font-semibold"
            : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        )}
      >
        <ArchiveFavicon archive={archive} />
        <span className="flex-1 truncate">{archive.label}</span>
      </Link>
      <button
        type="button"
        onClick={() => onPin(`read:${archive.sourceId}`)}
        aria-label={`Pin ${archive.label}`}
        className="absolute right-1 shrink-0 p-1 rounded opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-foreground transition-opacity focus-visible:opacity-100 focus-visible:outline-none"
      >
        <Pin className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

function ArchiveIconLink({ archive }: { archive: RecentArchive }) {
  const { pathname } = useLocation();
  const active = pathname === archive.href;
  return (
    <div className="group/tip relative flex justify-center">
      <Link
        to={archive.href}
        className={cn(
          "flex size-10 items-center justify-center rounded-lg transition-colors",
          active ? "bg-brand/10 text-brand" : "hover:bg-foreground/5",
        )}
      >
        <ArchiveFavicon archive={archive} />
      </Link>
      <span className="pointer-events-none absolute left-full top-1/2 ml-3 -translate-y-1/2 z-50 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md ring-1 ring-border/20 opacity-0 group-hover/tip:opacity-100 transition-opacity duration-100 delay-300">
        {archive.label}
      </span>
    </div>
  );
}

// ── Quick status switcher ───────────────────────────────────────────────────
const STATUS_PRESETS = [
  { state: 'available', label: 'Available', color: '#22c55e', icon: '🟢' },
  { state: 'busy',      label: 'Busy',      color: '#ef4444', icon: '🔴' },
  { state: 'focusing',  label: 'Focusing',  color: '#3b82f6', icon: '🔵' },
  { state: 'dnd',       label: 'DND',       color: '#7c3aed', icon: '🟣' },
  { state: 'brb',       label: 'BRB',       color: '#eab308', icon: '🟡' },
] as const

function StatusQuickSwitcher({ userId }: { userId: string }) {
  const [current, setCurrent] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!userId) return
    fetch('/api/pod/presence', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { status?: { state?: string } | null } | null) => {
        setCurrent(d?.status?.state ?? null)
      })
      .catch(() => { /* ignore */ })
  }, [userId])

  const setStatus = async (state: string | null) => {
    if (busy) return
    setBusy(true)
    try {
      if (!state) {
        await fetch('/api/pod/status', { method: 'DELETE', credentials: 'include' })
        setCurrent(null)
      } else {
        await fetch('/api/pod/status', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state }),
        })
        setCurrent(state)
      }
    } catch { /* ignore */ } finally { setBusy(false) }
  }

  return (
    <div className="px-2 py-1">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60 mb-1.5 px-1">Status</p>
      <div className="flex flex-wrap gap-1">
        {STATUS_PRESETS.map((p) => (
          <button
            key={p.state}
            disabled={busy}
            onClick={() => setStatus(current === p.state ? null : p.state)}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-60 ${
              current === p.state
                ? 'text-white shadow-sm'
                : 'bg-muted/60 text-muted-foreground hover:bg-muted'
            }`}
            style={current === p.state ? { backgroundColor: p.color } : undefined}
            title={current === p.state ? 'Click to clear' : `Set status to ${p.label}`}
          >
            <span>{p.icon}</span>
            <span>{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Notification helpers ────────────────────────────────────────────────────
// notifIcon / notifLabel / timeAgo live in @/lib/notifications, shared with the
// Settings → Notifications tab.

function BadgeCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="absolute top-1 right-1 bg-red-500 text-white text-[9px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5 pointer-events-none">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function LeftSidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const prefetch = useIntentPrefetch();
  const appFeatures = useAppFeatures();
  const { enabledToolIds } = useInstalledTools();
  const { pathname } = useLocation();
  const { imaging, video } = useGenerationContext();
  const { enabled: privacyEnabled, adultVisible } = usePrivacy();
  const busyDownloadPaths = useBusyAppPaths();
  const BADGE_EXPIRY_MS = 60_000

  const connectivity = useConnectivity()
  const [confirmOffline, setConfirmOffline] = useState(false)
  const { unreadCount, notifications, loadNotifications, markRead, markAllRead } = useNotifications()
  const [notifOpen, setNotifOpen] = useState(false)

  const handleNotifOpen = useCallback((open: boolean) => {
    setNotifOpen(open)
    if (open) void loadNotifications()
  }, [loadNotifications])

  // Fire toasts when device network state changes (only in Standard mode — Local only users already expect no internet)
  const prevHasNetworkRef = useRef<boolean | null>(null)
  useEffect(() => {
    const hasNetwork = connectivity?.hasNetwork ?? true
    if (prevHasNetworkRef.current === null) { prevHasNetworkRef.current = hasNetwork; return }
    if (hasNetwork === prevHasNetworkRef.current) return
    prevHasNetworkRef.current = hasNetwork
    if (connectivity?.appMode !== 'standard') return
    if (!hasNetwork) toast.error('No internet connection')
    else toast.success('Back online')
  }, [connectivity?.hasNetwork, connectivity?.appMode])

  async function applyConnectivity(newMode: 'online' | 'offline') {
    if (!user?.id) return
    await fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'connectivity.mode': newMode }),
    }).catch(() => {})
    window.dispatchEvent(new CustomEvent('connectivity-changed'))
  }

  function toggleConnectivity() {
    if (!connectivity || connectivity.forcedByAdmin || !user?.id) return
    if (connectivity.appMode === 'standard') {
      setConfirmOffline(true)
    } else {
      void applyConnectivity('online')
    }
  }

  function getAppBadge(href: string): 'busy' | 'done' | null {
    // Background first-run downloads still preparing this app's assets.
    if (busyDownloadPaths.has(href)) return 'busy'
    if (href === '/imaging') {
      const isAdultHidden = privacyEnabled && imaging.isAdult && !adultVisible
      if (!isAdultHidden && imaging.state.status === 'generating') return 'busy'
      if (!isAdultHidden && imaging.state.status === 'done' && !pathname.startsWith('/imaging')) {
        if (imaging.doneAt && Date.now() - imaging.doneAt < BADGE_EXPIRY_MS) return 'done'
      }
    }
    if (href === '/video') {
      const isAdultHidden = privacyEnabled && video.isAdult && !adultVisible
      if (!isAdultHidden && video.state.status === 'generating') return 'busy'
      if (!isAdultHidden && video.state.status === 'done' && !pathname.startsWith('/video')) {
        if (video.doneAt && Date.now() - video.doneAt < BADGE_EXPIRY_MS) return 'done'
      }
    }
    return null
  }

  const APPS = ALL_APPS.filter(
    (a) =>
      (!a.feature || appFeatures[a.feature] !== false) &&
      isAppVisible(a.toolId, enabledToolIds),
  );

  // Installed archives → map for resolving `read:<sourceId>` recents to a label
  // + favicon. The shared query refetches on focus so newly-installed archives resolve.
  const { data: installedArchives } = useInstalledArchives();
  const archiveMap = useMemo(() => {
    const m = new Map<string, RecentArchive>();
    for (const a of installedArchives ?? []) {
      m.set(a.sourceId, {
        sourceId: a.sourceId,
        label: a.label ?? a.sourceId,
        href: `/read/${a.sourceId}`,
        zimIconUrl: a.zimIconUrl ?? null,
        category: a.category ?? "Other",
      });
    }
    return m;
  }, [installedArchives]);

  const { pinnedIds, recentIds, collapsed, pin, unpin, reorder, toggleCollapsed } =
    useNavPreferences(APPS);

  const isWide = !collapsed;

  const appById = new Map(APPS.map((a) => [a.id, a]));
  const pinnedIdSet = new Set(pinnedIds);

  // Pinned = built-in apps OR pinned offline-library archives (`read:<sourceId>`),
  // in saved order. Anything can be pinned — including archives from Recent.
  const pinnedEntries: PinnedEntry[] = pinnedIds
    .map((id): PinnedEntry | null => {
      if (id.startsWith("read:")) {
        const archive = archiveMap.get(id.slice(5));
        return archive ? { id, kind: "archive", archive } : null;
      }
      const app = appById.get(id);
      return app ? { id, kind: "app", app } : null;
    })
    .filter((e): e is PinnedEntry => !!e);

  // Recent = the last 3 unique things the user opened (most-recent first):
  // built-in apps OR offline-library archives. Anything already pinned is
  // skipped here so it doesn't appear twice.
  const recentEntries: RecentEntry[] = [];
  const recentIdSet = new Set<string>();
  for (const id of recentIds) {
    if (recentEntries.length >= 3) break;
    if (pinnedIdSet.has(id)) continue;
    if (id.startsWith("read:")) {
      const archive = archiveMap.get(id.slice(5));
      if (archive) { recentEntries.push({ kind: "archive", archive }); recentIdSet.add(id); }
    } else {
      const app = appById.get(id);
      if (app) { recentEntries.push({ kind: "app", app }); recentIdSet.add(id); }
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = pinnedEntries.map((e) => e.id);
    const oldIdx = ids.indexOf(String(active.id));
    const newIdx = ids.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    reorder(arrayMove(ids, oldIdx, newIdx));
  }

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <>
    <aside
        style={{ width: isWide ? "13rem" : "3.5rem" }}
        className={cn(
          "group relative z-20 hidden md:flex shrink-0 flex-col border-r transition-[width,background-color,border-color] duration-300 ease-out",
          connectivity?.appMode === 'local'
            ? "border-amber-500/25 bg-gradient-to-b from-amber-950/30 via-background to-background"
            : connectivity && !connectivity.hasNetwork
            ? "border-red-500/25 bg-gradient-to-b from-red-950/30 via-background to-background"
            : "border-border/30 bg-gradient-to-b from-violet-950/30 via-background to-background",
        )}
      >
        {/* Hover-reveal collapse pill */}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-20",
            "flex h-12 w-5 items-center justify-center rounded-full",
            "border border-border/60 bg-background shadow-md",
            "text-muted-foreground hover:text-foreground hover:border-border hover:shadow-lg",
            "opacity-0 group-hover:opacity-100",
            "transition-opacity duration-150 ease-out",
            "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {collapsed ? (
            <ChevronRight className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronLeft className="size-3.5" aria-hidden="true" />
          )}
        </button>

        {/* App branding — mirrors the setup wizard's dark violet brand panel:
            glowing logo, bold wordmark, and tagline over a soft violet wash. */}
        <div
          className={cn(
            "relative flex shrink-0 items-center pt-5 pb-4",
            isWide ? "gap-2.5 px-4" : "justify-center px-0",
          )}
        >
          {/* Status-tinted wash behind the mark — the "dark left column" glow from setup */}
          <div className={cn(
            "pointer-events-none absolute inset-x-0 -top-6 h-28 bg-gradient-to-b to-transparent",
            connectivity?.appMode === 'local'
              ? "from-amber-600/15 via-amber-600/[0.04]"
              : connectivity && !connectivity.hasNetwork
              ? "from-red-600/15 via-red-600/[0.04]"
              : "from-violet-600/15 via-violet-600/[0.04]",
          )} />
          <BrandMark glow className={cn("relative", isWide ? "size-8" : "size-7")} />
          {isWide && (
            <div className="relative min-w-0">
              <h1 className="text-base font-black tracking-tight leading-none truncate">LokiDoki</h1>
              <p className="mt-1 text-[11px] leading-none text-muted-foreground truncate">Your private AI home hub</p>
            </div>
          )}
        </div>

        {/* Search — wide only */}
        {isWide && (
          <div className="shrink-0 px-2 mb-1">
            <SpotlightSearch />
          </div>
        )}

        {/* Nav: fixed top, scrollable pinned middle, fixed recent bottom */}
        <nav className="flex-1 min-h-0 flex flex-col overflow-hidden px-2 py-1">
          {isWide ? (
            <>
              {/* Home + App Store — always visible */}
              <div className="shrink-0 py-0.5">
                <NavWideLink href="/" icon={Home} label="Home" exact />
              </div>
              <div className="shrink-0 py-0.5">
                <NavWideLink href="/app-store" icon={ShoppingBag} label="App Store" />
              </div>

              {/* Pinned heading — always visible */}
              {pinnedEntries.length > 0 && (
                <div className="shrink-0">
                  <SectionHeading label="Pinned" count={pinnedEntries.length} />
                </div>
              )}

              {/* Pinned items — scrollable, takes remaining space.
                  ScrollFade adds top/bottom fade hints when the list overflows. */}
              <ScrollFade>
                {pinnedEntries.length > 0 && (
                  <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                    <SortableContext
                      items={pinnedEntries.map((e) => e.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {pinnedEntries.map((e) =>
                        e.kind === "app" ? (
                          <SortableNavItem
                            key={e.id}
                            id={e.id}
                            label={e.app.label}
                            href={e.app.href}
                            icon={e.app.gradient ? undefined : e.app.icon}
                            iconNode={e.app.gradient ? <AppIconTile icon={e.app.icon} gradient={e.app.gradient} /> : undefined}
                            onUnpin={unpin}
                            badge={getAppBadge(e.app.href)}
                            onIntent={() => prefetch(e.app.href)}
                          />
                        ) : (
                          <SortableNavItem
                            key={e.id}
                            id={e.id}
                            label={e.archive.label}
                            href={e.archive.href}
                            iconNode={<ArchiveFavicon archive={e.archive} />}
                            onUnpin={unpin}
                          />
                        ),
                      )}
                    </SortableContext>
                  </DndContext>
                )}
              </ScrollFade>

              {/* Recent — always visible at bottom (header + count always shown):
                  last 3 opened, excluding anything already pinned */}
              <div className="shrink-0">
                <SectionHeading label="Recent" count={recentEntries.length} />
                {recentEntries.map((e) =>
                  e.kind === "app" ? (
                    <NavItemWithPin
                      key={e.app.id}
                      app={e.app}
                      pinned={false}
                      onPin={pin}
                      onUnpin={unpin}
                      badge={getAppBadge(e.app.href)}
                      onIntent={() => prefetch(e.app.href)}
                    />
                  ) : (
                    <ArchiveRecentRow key={`read:${e.archive.sourceId}`} archive={e.archive} onPin={pin} />
                  ),
                )}
              </div>
            </>
          ) : (
            // Narrow mode: Home + App Store fixed, pinned scrollable, recent fixed
            <>
              <div className="shrink-0 flex justify-center py-0.5">
                <NavIconLink href="/" icon={Home} label="Home" exact />
              </div>
              <div className="shrink-0 flex justify-center py-0.5">
                <NavIconLink href="/app-store" icon={ShoppingBag} label="App Store" />
              </div>
              <ScrollFade>
                {pinnedEntries.map((e) => (
                  <div key={e.id} className="flex justify-center py-0.5">
                    {e.kind === "app" ? (
                      <NavIconLink href={e.app.href} icon={e.app.icon} gradient={e.app.gradient} label={e.app.label} badge={getAppBadge(e.app.href)} onIntent={() => prefetch(e.app.href)} />
                    ) : (
                      <ArchiveIconLink archive={e.archive} />
                    )}
                  </div>
                ))}
              </ScrollFade>
              <div className="shrink-0">
                {recentEntries.map((e) => (
                  <div key={e.kind === "app" ? e.app.id : `read:${e.archive.sourceId}`} className="flex justify-center py-0.5">
                    {e.kind === "app" ? (
                      <NavIconLink href={e.app.href} icon={e.app.icon} gradient={e.app.gradient} label={e.app.label} badge={getAppBadge(e.app.href)} onIntent={() => prefetch(e.app.href)} />
                    ) : (
                      <ArchiveIconLink archive={e.archive} />
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </nav>

        {/* Bottom: Admin + Connectivity + Profile */}
        <div className={cn("shrink-0 px-2 pb-5 pt-2", isWide ? "space-y-0.5" : "flex flex-col items-center gap-0.5")}>
          {user?.role === "admin" && (
            <>
              {isWide ? (
                <NavWideLink href="/admin" icon={ShieldCheck} label="Admin" />
              ) : (
                <NavIconLink href="/admin" icon={ShieldCheck} label="Admin" />
              )}
            </>
          )}

          {/* Connectivity status + toggle */}
          {user && connectivity && (
            isWide ? (
              <button
                type="button"
                onClick={toggleConnectivity}
                title={
                  connectivity.appMode === 'local' && connectivity.forcedByAdmin
                    ? 'Your admin has set local-only mode for all users'
                    : connectivity.appMode === 'local'
                    ? 'Local only — news, weather, and search are off. Click to switch to Standard.'
                    : !connectivity.hasNetwork
                    ? 'No internet connection — features requiring the network are unavailable.'
                    : 'Standard — internet features are on. Click to switch to Local only.'
                }
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  connectivity.appMode === 'local'
                    ? "text-amber-500 hover:bg-amber-500/10"
                    : !connectivity.hasNetwork
                    ? "text-red-500 hover:bg-red-500/10"
                    : "text-emerald-500 hover:bg-emerald-500/10",
                  connectivity.forcedByAdmin && "cursor-default",
                )}
              >
                {connectivity.appMode === 'local' || !connectivity.hasNetwork
                  ? <WifiOff className="size-4 shrink-0" />
                  : <Wifi className="size-4 shrink-0" />}
                <span className="flex-1 text-left font-medium">
                  {connectivity.appMode === 'local' ? 'Local only' : !connectivity.hasNetwork ? 'No connection' : 'Standard'}
                </span>
                {connectivity.forcedByAdmin && (
                  <span className="text-[10px] font-semibold opacity-60 shrink-0">Admin</span>
                )}
              </button>
            ) : (
              <div className="group/tip relative flex justify-center">
                <button
                  type="button"
                  onClick={toggleConnectivity}
                  className={cn(
                    "size-10 rounded-lg flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    connectivity.appMode === 'local'
                      ? "text-amber-500 hover:bg-amber-500/10"
                      : !connectivity.hasNetwork
                      ? "text-red-500 hover:bg-red-500/10"
                      : "text-emerald-500 hover:bg-emerald-500/10",
                  )}
                >
                  {connectivity.appMode === 'local' || !connectivity.hasNetwork
                    ? <WifiOff className="size-5" />
                    : <Wifi className="size-5" />}
                </button>
                <span className="pointer-events-none absolute left-full top-1/2 ml-3 -translate-y-1/2 z-50 max-w-52 whitespace-normal rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md ring-1 ring-border/20 opacity-0 group-hover/tip:opacity-100 transition-opacity duration-100 delay-300">
                  {connectivity.appMode === 'local' && connectivity.forcedByAdmin
                    ? 'Local only · set by your admin'
                    : connectivity.appMode === 'local'
                    ? 'Local only · click to switch to Standard'
                    : !connectivity.hasNetwork
                    ? 'No connection · switch to Local only or wait for signal'
                    : 'Standard · click to switch to Local only'}
                </span>
              </div>
            )
          )}

          {/* Profile + Notifications dropdown */}
          {user && (
            <DropdownMenu open={notifOpen} onOpenChange={handleNotifOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "relative flex items-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isWide ? "w-full gap-3 px-3 py-2 text-sm" : "size-10 justify-center",
                  )}
                >
                  <UserAvatar user={user} size={24} className="size-6 shrink-0 rounded-full" />
                  {isWide && <span className="truncate">{user.nickname || user.firstName}</span>}
                  <BadgeCount count={unreadCount} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="w-72">
                {/* Notifications section */}
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span className="text-xs font-semibold text-foreground">Notifications</span>
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      onClick={() => void markAllRead()}
                      className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Mark all read
                    </button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <div className="px-2 py-3 text-xs text-muted-foreground text-center">
                    No notifications
                  </div>
                ) : (
                  notifications.slice(0, 8).map((n) => {
                    const NIcon = notifIcon(n.type);
                    return (
                      <DropdownMenuItem
                        key={n.id}
                        onClick={() => { if (!n.readAt) void markRead(n.id); }}
                        className={cn(
                          "flex items-start gap-2 px-2 py-2 cursor-pointer",
                          !n.readAt && "bg-brand/5",
                        )}
                      >
                        <NIcon className={cn("size-4 mt-0.5 shrink-0", n.readAt ? "text-muted-foreground" : "text-brand")} />
                        <div className="flex-1 min-w-0">
                          <p className={cn("text-xs leading-snug truncate", !n.readAt && "font-medium")}>
                            {notifLabel(n)}
                          </p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{timeAgo(n.createdAt)}</p>
                        </div>
                        {!n.readAt && (
                          <span className="mt-1.5 size-1.5 rounded-full bg-brand shrink-0" />
                        )}
                      </DropdownMenuItem>
                    );
                  })
                )}
                <DropdownMenuSeparator />
                {/* Quick status switcher */}
                <StatusQuickSwitcher userId={user?.id ?? ''} />
                <DropdownMenuSeparator />
                {/* User menu items */}
                <DropdownMenuItem asChild>
                  <Link to="/settings" className="flex items-center gap-2">
                    <Settings className="size-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleLogout}
                  className="flex items-center gap-2 text-destructive focus:text-destructive"
                >
                  <LogOut className="size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </aside>
      <ConfirmDialog
        open={confirmOffline}
        onOpenChange={setConfirmOffline}
        title="Switch to Local only?"
        description="Internet features will be disabled — news, weather, search tools, and other external services won't work until you switch back to Standard."
        confirmLabel="Switch to Local only"
        onConfirm={() => applyConnectivity('offline')}
        destructive
      />
    </>
  );
}
