import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { APP_GROUPS } from "@/lib/appCategories";
import { useAppFeatures } from "@/hooks/useAppFeatures";
import { useInstalledTools, isAppVisible } from "@/hooks/useInstalledTools";
import { useNavPreferences, type NavApp, type NavPreferencesResult } from "@/hooks/useNavPreferences";

// Single owner of the nav preferences tracker (pinned/recent apps, sidebar collapse).
//
// Both the desktop LeftSidebar and the mobile nav sheet need pinned/recent state and
// the pin/unpin/reorder actions. The tracker also watches the route to append recents
// and debounce-writes them to the server, so it MUST run exactly once, two instances
// would double-write. This provider owns the one instance; every surface consumes it
// through useNavPrefs().
const Ctx = createContext<NavPreferencesResult | null>(null);

export function NavPreferencesProvider({ children }: { children: ReactNode }) {
  const appFeatures = useAppFeatures();
  const { enabledToolIds } = useInstalledTools();

  const apps = useMemo<NavApp[]>(
    () =>
      APP_GROUPS.flatMap((g) => g.apps)
        .filter(
          (a) =>
            (!a.feature || appFeatures[a.feature] !== false) &&
            isAppVisible(a.toolId, enabledToolIds),
        )
        .map((a) => ({ id: a.id, href: a.to })),
    [appFeatures, enabledToolIds],
  );

  const value = useNavPreferences(apps);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNavPrefs(): NavPreferencesResult {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNavPrefs must be used within a NavPreferencesProvider");
  return ctx;
}
