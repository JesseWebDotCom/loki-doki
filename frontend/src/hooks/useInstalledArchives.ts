import { useQuery } from "@tanstack/react-query";

// Installed offline-library archives (`GET /api/archives/installed`), shared
// app-wide through one React Query cache entry. Refetches on window focus once
// stale so newly-installed archives resolve — this replaces the per-component
// manual focus listeners the sidebar and home page used to register.

export interface InstalledArchive {
  id: string;
  sourceId: string;
  label: string;
  description: string | null;
  category: string;
  zimIconUrl: string | null;
  fileSizeBytes: number | null;
}

export function useInstalledArchives() {
  return useQuery({
    queryKey: ["archives-installed"],
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<InstalledArchive[]> => {
      const r = await fetch("/api/archives/installed", { credentials: "include" });
      if (!r.ok) return [];
      const d = (await r.json()) as { archives?: InstalledArchive[] };
      return d.archives ?? [];
    },
  });
}
