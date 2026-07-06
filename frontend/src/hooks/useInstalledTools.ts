import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

export interface InstalledTool {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  /** Companion may use this tool in chat (app-settings ability toggle). */
  chatEnabled?: boolean;
  /** Core companion plumbing: never shown on user surfaces. */
  core?: boolean;
  offline?: boolean;
  dataSources?: { name: string; domain: string; purpose: string; type: string }[];
}

interface UseInstalledToolsResult {
  /** Set of tool IDs where enabled === true. null while loading. */
  enabledToolIds: Set<string> | null;
  isLoading: boolean;
  /** Full tool list from /api/tools. null while loading. */
  tools: InstalledTool[] | null;
}

/**
 * Fetches /api/tools (shared React Query cache — deduped across all consumers)
 * and returns the set of enabled tool IDs plus the raw tool list.
 * Use this to filter app listings — only show apps whose toolId is in
 * enabledToolIds (or apps that have no toolId at all, which are always shown).
 *
 * Do NOT use in AdminFeaturesTab, AdminAppsTab, or AppStorePage — those need
 * to show all tools regardless of enabled status.
 */
export function useInstalledTools(): UseInstalledToolsResult {
  const { data, isError } = useQuery({
    queryKey: ["tools"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<InstalledTool[]> => {
      const r = await fetch("/api/tools", { credentials: "include" });
      return r.ok ? ((await r.json()) as InstalledTool[]) : [];
    },
  });

  const tools = useMemo(() => data ?? (isError ? [] : null), [data, isError]);
  const enabledToolIds = useMemo(
    () => (tools ? new Set(tools.filter((t) => t.enabled).map((t) => t.id)) : null),
    [tools],
  );

  return { enabledToolIds, isLoading: tools === null, tools };
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
