import { useEffect, useState } from "react";

export interface InstalledTool {
  id: string;
  name: string;
  enabled: boolean;
}

interface UseInstalledToolsResult {
  /** Set of tool IDs where enabled === true. null while loading. */
  enabledToolIds: Set<string> | null;
  isLoading: boolean;
}

/**
 * Fetches /api/tools and returns the set of enabled tool IDs.
 * Use this to filter app listings — only show apps whose toolId is in
 * enabledToolIds (or apps that have no toolId at all, which are always shown).
 *
 * Do NOT use in AdminFeaturesTab, AdminAppsTab, or AppStorePage — those need
 * to show all tools regardless of enabled status.
 */
export function useInstalledTools(): UseInstalledToolsResult {
  const [enabledToolIds, setEnabledToolIds] = useState<Set<string> | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tools", { credentials: "include" })
      .then((r) => r.ok ? r.json() as Promise<InstalledTool[]> : Promise.resolve([]))
      .then((tools) => {
        if (cancelled) return;
        const ids = new Set(tools.filter((t) => t.enabled).map((t) => t.id));
        setEnabledToolIds(ids);
      })
      .catch(() => {
        if (!cancelled) setEnabledToolIds(new Set());
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { enabledToolIds, isLoading };
}

/**
 * Returns true if an app should be visible to regular users.
 * - Apps with no toolId are always visible (they have no install toggle).
 * - Apps with a toolId are only visible if that tool is in the enabled set.
 * - While tools are still loading (enabledToolIds === null), defaults to visible
 *   to avoid a flash of empty content.
 */
export function isAppVisible(
  toolId: string | undefined,
  enabledToolIds: Set<string> | null,
): boolean {
  if (!toolId) return true;
  if (enabledToolIds === null) return true; // still loading — show optimistically
  return enabledToolIds.has(toolId);
}
