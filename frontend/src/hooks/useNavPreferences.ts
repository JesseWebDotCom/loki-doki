import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { useUserPreferences, patchUserPreferencesCache } from "@/hooks/useUserPreferences";

const DEFAULT_PINNED = ["chat", "maps", "weather", "time", "news", "imaging", "links", "youtube", "podcasts"];
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
  const queryClient = useQueryClient();
  const prefsQuery = useUserPreferences();

  // Local state seeds DEFAULT_PINNED synchronously so the nav renders instantly,
  // then adopts the saved order once the shared preferences query resolves.
  const [pinnedIds, setPinnedIds] = useState<string[]>([...DEFAULT_PINNED]);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  const loadedRef = useRef(false);
  const userIdRef = useRef<string | undefined>(user?.id);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    userIdRef.current = user?.id;
  }, [user?.id]);

  // Seed from the shared preferences query once per user session
  useEffect(() => {
    if (loadedRef.current) return;
    if (prefsQuery.data === undefined && !prefsQuery.isError) return; // still loading
    const data = prefsQuery.data ?? {};
    const pinned = data["nav.pinned_apps"];
    const recent = data["nav.recent_apps"];
    const col = data["nav.sidebar_collapsed"];
    if (Array.isArray(pinned) && pinned.length > 0) setPinnedIds(pinned as string[]);
    if (Array.isArray(recent)) setRecentIds(recent as string[]);
    if (typeof col === "boolean") setCollapsed(col);
    loadedRef.current = true;
  }, [prefsQuery.data, prefsQuery.isError]);

  // Debounced write — stable reference so it never invalidates other callbacks.
  // The shared query cache is patched immediately (before the debounce fires) so
  // other readers of ['user-preferences'] stay consistent with what we render.
  const persistToDb = useCallback((patch: Record<string, unknown>) => {
    const userId = userIdRef.current;
    if (!userId) return;
    patchUserPreferencesCache(queryClient, userId, patch);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      fetch(`/api/users/${userId}/preferences`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    }, DEBOUNCE_MS);
  }, [queryClient]);

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
