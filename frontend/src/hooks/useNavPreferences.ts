import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";

const DEFAULT_PINNED = ["chat", "maps", "weather", "news", "imaging", "links", "youtube", "podcasts"];
const MAX_RECENT = 3;
const DEBOUNCE_MS = 600;

export interface NavApp {
  id: string;
  href: string;
}

export interface NavPreferencesResult {
  pinnedIds: readonly string[];
  recentIds: readonly string[];
  collapsed: boolean;
  pin: (id: string) => void;
  unpin: (id: string) => void;
  reorder: (ids: string[]) => void;
  toggleCollapsed: () => void;
}

export function useNavPreferences(apps: readonly NavApp[]): NavPreferencesResult {
  const { user } = useAuth();
  const { pathname } = useLocation();

  const [pinnedIds, setPinnedIds] = useState<string[]>([...DEFAULT_PINNED]);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  const loadedRef = useRef(false);
  const userIdRef = useRef<string | undefined>(user?.id);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    userIdRef.current = user?.id;
  }, [user?.id]);

  // Load preferences from DB once per user session
  useEffect(() => {
    if (!user?.id) return;
    fetch(`/api/users/${user.id}/preferences`, { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : Promise.resolve(null)))
      .then((data) => {
        if (!data) return;
        const pinned = data["nav.pinned_apps"];
        const recent = data["nav.recent_apps"];
        const col = data["nav.sidebar_collapsed"];
        if (Array.isArray(pinned) && pinned.length > 0) setPinnedIds(pinned as string[]);
        if (Array.isArray(recent)) setRecentIds(recent as string[]);
        if (typeof col === "boolean") setCollapsed(col);
      })
      .finally(() => {
        loadedRef.current = true;
      });
  }, [user?.id]);

  // Debounced write — stable reference so it never invalidates other callbacks
  const persistToDb = useCallback((patch: Record<string, unknown>) => {
    if (!userIdRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      fetch(`/api/users/${userIdRef.current}/preferences`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    }, DEBOUNCE_MS);
  }, []);

  // Track navigation for recent apps (only fires after initial load).
  // Recents cover both built-in apps and opened offline-library archives
  // (`/read/:sourceId`, stored as `read:<sourceId>`), since archives are the
  // app-store "apps" on the home screen.
  useEffect(() => {
    if (!loadedRef.current) return;

    let key: string | null = null;
    if (pathname.startsWith("/read/")) {
      const sid = pathname.split("/")[2];
      if (sid) key = `read:${decodeURIComponent(sid)}`;
    } else {
      const matched = apps.find(
        (app) =>
          app.id !== "today" &&
          (pathname === app.href || pathname.startsWith(app.href + "/")),
      );
      if (matched) key = matched.id;
    }
    if (!key) return;

    const k = key;
    setRecentIds((prev) => {
      if (prev[0] === k) return prev; // already at top — no churn
      const next = [k, ...prev.filter((id) => id !== k)].slice(
        0,
        MAX_RECENT + DEFAULT_PINNED.length,
      );
      persistToDb({ "nav.recent_apps": next });
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const pin = useCallback(
    (id: string) => {
      setPinnedIds((prev) => {
        if (prev.includes(id)) return prev;
        const next = [...prev, id];
        persistToDb({ "nav.pinned_apps": next });
        return next;
      });
    },
    [persistToDb],
  );

  const unpin = useCallback(
    (id: string) => {
      setPinnedIds((prev) => {
        const next = prev.filter((p) => p !== id);
        persistToDb({ "nav.pinned_apps": next });
        return next;
      });
    },
    [persistToDb],
  );

  const reorder = useCallback(
    (ids: string[]) => {
      setPinnedIds(ids);
      persistToDb({ "nav.pinned_apps": ids });
    },
    [persistToDb],
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      persistToDb({ "nav.sidebar_collapsed": next });
      return next;
    });
  }, [persistToDb]);

  return { pinnedIds, recentIds, collapsed, pin, unpin, reorder, toggleCollapsed };
}
