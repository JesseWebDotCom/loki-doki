import { useMemo } from 'react'
import type { LucideIcon } from 'lucide-react'
import { APP_GROUPS } from '@/lib/appCategories'
import { useNavPrefs } from '@/context/NavPreferencesContext'
import { useInstalledTools, isAppVisible } from '@/hooks/useInstalledTools'
import { useAppFeatures } from '@/hooks/useAppFeatures'
import { useInstalledArchives } from '@/hooks/useInstalledArchives'

// A resolved, launchable favorite: either a built-in app pin (APP_GROUPS id) or an
// offline-library archive pin (`read:<sourceId>`), in the user's saved order.
export interface PinnedLaunchEntry {
  id: string
  label: string
  href: string
  icon?: LucideIcon
  gradient?: string
  color?: string
  /** Archive pins only: favicon + category for ArchiveIcon rendering. */
  zimIconUrl?: string | null
  archiveCategory?: string
}

// Resolves the user's Favorites (NavPreferences pins) into launchable entries with the
// same feature/tool visibility gates the LeftSidebar applies. Shared by the sidebar-style
// surfaces and the mobile dock's Favorites fan so the two lists never diverge.
export function usePinnedApps(): PinnedLaunchEntry[] {
  const { pinnedIds } = useNavPrefs()
  const appFeatures = useAppFeatures()
  const { enabledToolIds } = useInstalledTools()
  const { data: installedArchives } = useInstalledArchives()

  return useMemo(() => {
    const appById = new Map(
      APP_GROUPS.flatMap((g) => g.apps).map((a) => [
        a.id,
        { id: a.id, label: a.label, href: a.to, icon: a.icon, gradient: a.gradient, color: a.color, feature: a.feature, toolId: a.toolId },
      ]),
    )
    const archiveById = new Map(
      (installedArchives ?? []).map((a) => [
        a.sourceId,
        {
          id: `read:${a.sourceId}`,
          label: a.label ?? a.sourceId,
          href: `/read/${a.sourceId}`,
          zimIconUrl: a.zimIconUrl ?? null,
          archiveCategory: a.category ?? 'Other',
        },
      ]),
    )
    return pinnedIds
      .map((id): PinnedLaunchEntry | null => {
        if (id.startsWith('read:')) return archiveById.get(id.slice(5)) ?? null
        const app = appById.get(id)
        if (!app) return null
        if (app.feature && appFeatures[app.feature] === false) return null
        if (!isAppVisible(app.toolId, enabledToolIds)) return null
        return { id: app.id, label: app.label, href: app.href, icon: app.icon, gradient: app.gradient, color: app.color }
      })
      .filter((e): e is PinnedLaunchEntry => !!e)
  }, [pinnedIds, appFeatures, enabledToolIds, installedArchives])
}
