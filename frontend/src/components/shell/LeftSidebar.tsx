import { Link, useLocation, useNavigate } from "react-router-dom";
import { useGenerationContext } from "@/context/GenerationContext";
import { usePrivacy } from "@/context/PrivacyContext";
import { useBusyAppPaths } from "@/context/SetupProgressContext";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Circle,
  FlaskConical,
  Home,
  LayoutGrid,
  LogOut,
  MonitorDown,
  Settings,
  ShieldCheck,
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
import { APP_GROUPS } from "@/lib/appCategories";
import { useInstalledTools, isAppVisible } from "@/hooks/useInstalledTools";
import { useAppFeatures } from "@/hooks/useAppFeatures";
import { useInstalledArchives } from "@/hooks/useInstalledArchives";
import { usePresenceStatus } from "@/hooks/usePresenceStatus";
import { STATUS_PRESETS } from "@/lib/presence";
import { AppIconTile } from "@/components/shared/AppIconTile";
import { AiGeneratedBadge } from "@/components/shared/AiGeneratedBadge";
import { ArchiveIcon } from "@/components/shared/ArchiveIcon";
import { BrandMark } from "@/components/shared/BrandMark";
import { StatusDot } from "@/components/shared/StatusDot";
import { useAuth } from "@/context/AuthContext";
import { SpotlightTrigger } from "@/components/shared/SpotlightSearch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SortableNavItem } from "./SortableNavItem";
import { AppLauncher } from "./AppLauncher";
import { CompanionDock } from "./CompanionDock";
import { useNavPrefs } from "@/context/NavPreferencesContext";
import { useIntentPrefetch } from "@/lib/prefetch/useIntentPrefetch";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { TesterDialog } from "@/components/diagnostics/TesterDialog";
import { DesktopAppDialog } from "@/components/shared/DesktopAppDialog";
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
  color?: string;
  feature?: string;
  toolId?: string;
}

const ALL_APPS: AppEntry[] = APP_GROUPS.flatMap(g =>
  g.apps.map(a => ({ id: a.id, label: a.label, href: a.to, icon: a.icon, gradient: a.gradient, color: a.color, feature: a.feature, toolId: a.toolId }))
);

function SectionHeading({ label }: { label: string }) {
  return (
    <div className="flex items-center px-3 pt-3 pb-1 select-none">
      <p className="text-overline text-muted-foreground/70 flex-1">{label}</p>
    </div>
  );
}

function AppBadgeDot({ badge }: { badge: 'busy' | 'done' }) {
  return <StatusDot status={badge === 'busy' ? 'info' : 'ok'} pulse={badge === 'busy'} />;
}

function NavIconLink({
  href,
  icon: Icon,
  label,
  exact,
  badge,
  gradient,
  color,
  onIntent,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
  badge?: 'busy' | 'done' | null;
  gradient?: string;
  color?: string;
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
          "relative flex size-10 items-center justify-center rounded-control transition-colors",
          active
            ? "bg-brand/10"
            : "hover:bg-foreground/5",
          !gradient && (active ? "text-brand" : "text-muted-foreground hover:text-foreground"),
        )}
      >
        {gradient
          ? <AppIconTile icon={Icon} gradient={gradient} color={color} variant="flat" />
          : <Icon className="size-4" />}
        {badge && (
          <span className="absolute top-1.5 right-1.5">
            <AppBadgeDot badge={badge} />
          </span>
        )}
      </Link>
      <span className="pointer-events-none absolute left-full top-1/2 ml-3 -translate-y-1/2 z-50 whitespace-nowrap rounded-control bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md ring-1 ring-border/20 opacity-0 group-hover/tip:opacity-100 transition-opacity duration-100 delay-300">
        {label}
      </span>
    </div>
  );
}

function NavIconButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="group/tip relative flex justify-center">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex size-10 items-center justify-center rounded-control transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active
            ? "bg-brand/10 text-brand"
            : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        )}
      >
        <Icon className="size-4" aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </button>
      <span className="pointer-events-none absolute left-full top-1/2 ml-3 -translate-y-1/2 z-50 whitespace-nowrap rounded-control bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md ring-1 ring-border/20 opacity-0 group-hover/tip:opacity-100 transition-opacity duration-100 delay-300">
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
        "flex w-full items-center gap-3 rounded-control px-3 py-2 text-sm transition-colors",
        active
          ? "bg-brand/10 font-medium"
          : "hover:bg-foreground/5",
        !gradient && (active ? "text-brand" : "text-muted-foreground hover:text-foreground"),
        gradient && (active ? "text-foreground" : "text-muted-foreground hover:text-foreground"),
      )}
    >
      {gradient
        ? <AppIconTile icon={Icon} gradient={gradient} />
        : <Icon className="size-4 shrink-0" />}
      <span className="flex-1 truncate">{label}</span>
      {badge && <AppBadgeDot badge={badge} />}
    </Link>
  );
}

function NavWideButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-control px-3 py-2 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-brand/10 text-brand font-medium"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 truncate text-left">{label}</span>
    </button>
  );
}

// An installed offline-library archive resolved from a `read:<sourceId>` pin key.
interface PinnedArchive {
  sourceId: string;
  label: string;
  href: string;
  zimIconUrl: string | null;
  category: string;
}

type PinnedEntry =
  | { id: string; kind: "app"; app: AppEntry }
  | { id: string; kind: "archive"; archive: PinnedArchive };

function ArchiveFavicon({ archive }: { archive: PinnedArchive }) {
  const visual = categoryVisual(archive.category);
  return (
    <span
      // design-ok(radius-off-scale): matches AppIconTile's size-5 tile radius
      className="flex size-5 shrink-0 items-center justify-center rounded-md"
      style={{ background: visual.gradient }}
    >
      <ArchiveIcon zimIconUrl={archive.zimIconUrl} category={archive.category} />
    </span>
  );
}

function ArchiveIconLink({ archive }: { archive: PinnedArchive }) {
  const { pathname } = useLocation();
  const active = pathname === archive.href;
  return (
    <div className="group/tip relative flex justify-center">
      <Link
        to={archive.href}
        className={cn(
          "flex size-10 items-center justify-center rounded-control transition-colors",
          active ? "bg-brand/10 text-brand" : "hover:bg-foreground/5",
        )}
      >
        <ArchiveFavicon archive={archive} />
      </Link>
      <span className="pointer-events-none absolute left-full top-1/2 ml-3 -translate-y-1/2 z-50 whitespace-nowrap rounded-control bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md ring-1 ring-border/20 opacity-0 group-hover/tip:opacity-100 transition-opacity duration-100 delay-300">
        {archive.label}
      </span>
    </div>
  );
}

// ── Quick status switcher ───────────────────────────────────────────────────
// Current/setStatus/busy are lifted to LeftSidebar (usePresenceStatus) so the
// profile avatar can show the same status dot the switcher itself sets.
function StatusQuickSwitcher({ current, setStatus, busy }: {
  current: string | null
  setStatus: (state: string | null) => void | Promise<void>
  busy: boolean
}) {
  const currentPreset = STATUS_PRESETS.find((p) => p.state === current)

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="flex items-center gap-2">
        <Circle
          className="size-2.5 shrink-0 fill-current"
          style={{ color: currentPreset?.color ?? 'var(--muted-foreground)' }}
        />
        <span className="flex-1">{currentPreset ? currentPreset.label : 'Set status'}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {STATUS_PRESETS.map((p) => (
          <DropdownMenuItem
            key={p.state}
            disabled={busy}
            onClick={() => setStatus(current === p.state ? null : p.state)}
            className="flex items-center gap-2"
          >
            <Circle className="size-2.5 shrink-0 fill-current" style={{ color: p.color }} />
            <span className="flex-1">{p.label}</span>
            {current === p.state && <Check className="size-3.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
        {current && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} onClick={() => setStatus(null)} className="text-muted-foreground">
              Clear status
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

// ── Notification helpers ────────────────────────────────────────────────────
// notifIcon / notifLabel / timeAgo live in @/lib/notifications, shared with the
// Settings → Notifications tab.

function BadgeCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="absolute top-1 right-1 bg-destructive text-destructive-foreground text-[9px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5 pointer-events-none">
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
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [testerOpen, setTesterOpen] = useState(false)
  const [desktopAppOpen, setDesktopAppOpen] = useState(false)
  const { unreadCount, notifications, digest, loadNotifications, markRead, markAllRead } = useNotifications()
  const [notifOpen, setNotifOpen] = useState(false)
  const presence = usePresenceStatus(user?.id)
  const currentStatusPreset = STATUS_PRESETS.find((p) => p.state === presence.current)

  const handleNotifOpen = useCallback((open: boolean) => {
    setNotifOpen(open)
    if (open) void loadNotifications()
  }, [loadNotifications])

  // Fire toasts when device network state changes (only in Standard mode, Local only users already expect no internet)
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
    if (href === '/videos') {
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

  // Installed archives → map for resolving `read:<sourceId>` pins to a label
  // + favicon. The shared query refetches on focus so newly-installed archives resolve.
  const { data: installedArchives } = useInstalledArchives();
  const archiveMap = useMemo(() => {
    const m = new Map<string, PinnedArchive>();
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
    useNavPrefs();

  const isWide = !collapsed;

  const appById = new Map(APPS.map((a) => [a.id, a]));

  // Favorites = pinned built-in apps OR pinned offline-library archives
  // (`read:<sourceId>`), in saved order. The full list renders in the sidebar;
  // ScrollFade handles overflow when it outgrows the column.
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const resolvedIds = pinnedEntries.map((e) => e.id);
    const oldIdx = resolvedIds.indexOf(String(active.id));
    const newIdx = resolvedIds.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    // Reorder the resolved entries; keep any pins that didn't resolve (e.g. an
    // uninstalled archive) in saved order at the end.
    const moved = arrayMove(resolvedIds, oldIdx, newIdx);
    const resolvedSet = new Set(resolvedIds);
    const rest = pinnedIds.filter((id) => !resolvedSet.has(id));
    reorder([...moved, ...rest]);
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
          "group relative z-20 hidden md:flex shrink-0 flex-col border-r bg-sidebar transition-[width,background-color,border-color] duration-300 ease-out",
          connectivity?.appMode === 'local'
            ? "border-warning/15"
            : connectivity && !connectivity.hasNetwork
            ? "border-destructive/15"
            : "border-sidebar-border",
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

        {/* Brand block: glowing mark + wordmark over a whisper of brand glow.
            Connectivity states tint the glow amber (local only) or red (offline). */}
        <div
          className={cn(
            "relative flex shrink-0 items-center pt-5 pb-4",
            isWide ? "gap-2.5 px-4" : "justify-center px-0",
          )}
        >
          <div className={cn(
            "pointer-events-none absolute inset-x-0 -top-6 h-28 bg-gradient-to-b to-transparent",
            connectivity?.appMode === 'local'
              ? "from-warning/[0.08] via-warning/[0.02]"
              : connectivity && !connectivity.hasNetwork
              ? "from-destructive/[0.08] via-destructive/[0.02]"
              : "from-brand/[0.08] via-brand/[0.02]",
          )} />
          <BrandMark glow className={cn("relative", isWide ? "size-8" : "size-7")} />
          {isWide && (
            <div className="relative min-w-0">
              <p className="text-sm font-semibold tracking-tight leading-none truncate text-foreground">Loki Doki</p>
              <p className="mt-1 text-[11px] leading-none text-muted-foreground truncate">Your private AI home hub</p>
            </div>
          )}
        </div>

        {/* Prestige edge: the one sanctioned brand-gradient hairline. The profile
            card rests directly on it, so it reads as the card's top edge. */}
        <div
          aria-hidden
          className={cn("h-px shrink-0", isWide ? "mx-2" : "mx-1")}
          style={{ background: "var(--brand-gradient)", opacity: 0.5 }}
        />

        {/* Profile card, shadcn NavUser style: avatar + name + role with the
            notifications/status/settings dropdown. Lives under the brand block
            so the sidebar footer belongs to the companion. */}
        {user && (
          <div className={cn("shrink-0", isWide ? "px-2" : "px-1 flex justify-center")}>
            <DropdownMenu open={notifOpen} onOpenChange={handleNotifOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "relative flex items-center rounded-control text-left transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isWide
                      ? "w-full gap-2.5 rounded-t-none bg-secondary/60 p-2 hover:bg-secondary"
                      : "size-10 justify-center hover:bg-foreground/5",
                  )}
                >
                  <span className="shrink-0">
                    <UserAvatar
                      user={user}
                      size={isWide ? 32 : 28}
                      className={cn("rounded-control", isWide ? "size-8" : "size-7")}
                    />
                  </span>
                  {isWide && (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold leading-tight">
                          {user.nickname || user.firstName}
                        </span>
                        <span className="flex items-center gap-1.5 truncate text-caption leading-tight text-muted-foreground">
                          <Circle
                            className="size-1.5 shrink-0 fill-current"
                            style={{ color: currentStatusPreset?.color ?? 'var(--muted-foreground)' }}
                          />
                          {currentStatusPreset ? currentStatusPreset.label : 'Set status'}
                        </span>
                      </span>
                      <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </>
                  )}
                  <BadgeCount count={unreadCount} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="start" className="w-72">
                {/* Notifications section */}
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span className="text-xs font-semibold text-foreground">Notifications</span>
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      onClick={() => void markAllRead()}
                      className="text-caption text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Mark all read
                    </button>
                  )}
                </div>
                {digest && (
                  <div className="mx-2 mb-1 rounded-control bg-brand/5 px-2 py-1.5">
                    <AiGeneratedBadge label="Summarized by Loki" tone="brand" className="mb-1" />
                    <p className="text-xs leading-snug text-foreground">{digest}</p>
                  </div>
                )}
                {notifications.length === 0 ? (
                  <div className="px-2 py-3 text-xs text-muted-foreground text-center">
                    No notifications
                  </div>
                ) : (
                  notifications.slice(0, 4).map((n) => {
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
                <StatusQuickSwitcher current={presence.current} setStatus={presence.setStatus} busy={presence.busy} />
                <DropdownMenuSeparator />
                {/* User menu items */}
                <DropdownMenuItem asChild>
                  <Link to="/settings" className="flex items-center gap-2">
                    <Settings className="size-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
                {user.role === "admin" && (
                  <DropdownMenuItem asChild>
                    <Link to="/admin" className="flex items-center gap-2">
                      <ShieldCheck className="size-4" />
                      Admin
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => setTesterOpen(true)}
                  className="flex items-center gap-2"
                >
                  <FlaskConical className="size-4" />
                  Tester
                </DropdownMenuItem>
                {/* Doki Dock installer, pointless when already inside the shell. */}
                {!window.lokiDesktop && (
                  <DropdownMenuItem
                    onClick={() => setDesktopAppOpen(true)}
                    className="flex items-center gap-2"
                  >
                    <MonitorDown className="size-4" />
                    Get the desktop app
                  </DropdownMenuItem>
                )}
                {connectivity && (
                  <DropdownMenuItem
                    onClick={toggleConnectivity}
                    disabled={connectivity.forcedByAdmin}
                    title={
                      connectivity.appMode === 'local' && connectivity.forcedByAdmin
                        ? 'Your admin has set local-only mode for all users'
                        : connectivity.appMode === 'local'
                        ? 'Local only, news, weather, and search are off. Click to switch to Standard.'
                        : !connectivity.hasNetwork
                        ? 'No internet connection, features requiring the network are unavailable.'
                        : 'Standard, internet features are on. Click to switch to Local only.'
                    }
                    className={cn(
                      "flex items-center gap-2",
                      connectivity.appMode === 'local'
                        ? "text-warning focus:text-warning"
                        : !connectivity.hasNetwork
                        ? "text-destructive focus:text-destructive"
                        : "text-success focus:text-success",
                    )}
                  >
                    {connectivity.appMode === 'local' || !connectivity.hasNetwork
                      ? <WifiOff className="size-4" />
                      : <Wifi className="size-4" />}
                    <span className="flex-1">
                      {connectivity.appMode === 'local' ? 'Local only' : !connectivity.hasNetwork ? 'No connection' : 'Standard'}
                    </span>
                    {connectivity.forcedByAdmin && (
                      <span className="text-overline opacity-60">Admin</span>
                    )}
                  </DropdownMenuItem>
                )}
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
          </div>
        )}

        {/* Search, wide only */}
        {isWide && (
          <div className="shrink-0 px-2 mt-2 mb-1">
            <SpotlightTrigger />
          </div>
        )}

        {/* Nav: Home + Apps fixed on top, Favorites scrollable below */}
        <nav className={cn("flex-1 min-h-0 flex flex-col overflow-hidden px-2 py-1", !isWide && "mt-2")}>
          {isWide ? (
            <>
              <div className="shrink-0 py-0.5">
                <NavWideLink href="/" icon={Home} label="Home" exact />
              </div>
              <div className="shrink-0 py-0.5">
                <NavWideButton
                  icon={LayoutGrid}
                  label="Apps"
                  active={launcherOpen}
                  onClick={() => setLauncherOpen(true)}
                />
              </div>

              {pinnedEntries.length > 0 && (
                <>
                  <div className="shrink-0">
                    <SectionHeading label="Favorites" />
                  </div>

                  {/* Favorites, scrollable, takes remaining space.
                      ScrollFade adds top/bottom fade hints when the list overflows. */}
                  <ScrollFade>
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
                              iconNode={e.app.gradient ? <AppIconTile icon={e.app.icon} gradient={e.app.gradient} color={e.app.color} variant="flat" /> : undefined}
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
                  </ScrollFade>
                </>
              )}
            </>
          ) : (
            // Narrow mode: Home + Apps fixed, favorites scrollable icon rail
            <>
              <div className="shrink-0 flex justify-center py-0.5">
                <NavIconLink href="/" icon={Home} label="Home" exact />
              </div>
              <div className="shrink-0 flex justify-center py-0.5">
                <NavIconButton
                  icon={LayoutGrid}
                  label="Apps"
                  active={launcherOpen}
                  onClick={() => setLauncherOpen(true)}
                />
              </div>
              <ScrollFade>
                {pinnedEntries.map((e) => (
                  <div key={e.id} className="flex justify-center py-0.5">
                    {e.kind === "app" ? (
                      <NavIconLink href={e.app.href} icon={e.app.icon} gradient={e.app.gradient} color={e.app.color} label={e.app.label} badge={getAppBadge(e.app.href)} onIntent={() => prefetch(e.app.href)} />
                    ) : (
                      <ArchiveIconLink archive={e.archive} />
                    )}
                  </div>
                ))}
              </ScrollFade>
            </>
          )}
        </nav>

        {/* Companion dock: the sidebar footer. The buddy lives bottom-left on a
            soft plum wash echoing the logo tile, set off by a hairline. */}
        <div className="shrink-0 border-t border-sidebar-border bg-gradient-to-t from-brand/[0.07] via-brand/[0.02] to-transparent">
          <CompanionDock collapsed={!isWide} />
        </div>
      </aside>
      <AppLauncher
        open={launcherOpen}
        onOpenChange={setLauncherOpen}
        pinnedIds={pinnedIds}
        recentIds={recentIds}
        onPin={pin}
        onUnpin={unpin}
      />
      <TesterDialog open={testerOpen} onOpenChange={setTesterOpen} />
      <DesktopAppDialog open={desktopAppOpen} onOpenChange={setDesktopAppOpen} />
      <ConfirmDialog
        open={confirmOffline}
        onOpenChange={setConfirmOffline}
        title="Switch to Local only?"
        description="Internet features will be disabled, news, weather, search tools, and other external services won't work until you switch back to Standard."
        confirmLabel="Switch to Local only"
        onConfirm={() => applyConnectivity('offline')}
        destructive
      />
    </>
  );
}
