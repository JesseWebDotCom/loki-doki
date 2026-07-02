import { useQuery } from "@tanstack/react-query";

// App-level feature flags gated by admin toggle (`GET /api/app-features`).
// Shared React Query cache so every consumer (sidebar, home categories, …)
// dedupes to a single request; refetches on window focus once stale.

export type AppFeatures = Record<string, boolean>;

const EMPTY: AppFeatures = {};

export function useAppFeatures(): AppFeatures {
  const { data } = useQuery({
    queryKey: ["app-features"],
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<AppFeatures> => {
      const r = await fetch("/api/app-features", { credentials: "include" });
      return r.ok ? ((await r.json()) as AppFeatures) : EMPTY;
    },
  });
  // Missing/unloaded flags read as "not disabled" — callers check `flags[f] !== false`.
  return data ?? EMPTY;
}
