// The Coding app: OpenCode's own web UI, full-bleed, right below the app breadcrumb.
// No project list of our own: OpenCode's own UI already has a full project picker
// (open/recent/switch), so we don't duplicate it. Every user gets one persistent
// sandboxed workspace (data/coding/users/<userId>/, see codingServer.ts); OpenCode
// manages whatever projects live under it.
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

export function CodingPage() {
  const { data, error, isLoading } = useQuery({
    queryKey: ["coding", "ui-url"],
    queryFn: async (): Promise<{ url: string }> => {
      const res = await fetch("/api/coding/ui-url");
      const body = await res.json() as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? "Couldn't start the coding sidecar");
      return { url: body.url };
    },
    retry: false,
    staleTime: 0, // tokens are single-use, never serve a cached one into a fresh iframe load
  });

  if (isLoading) {
    return <div className="flex h-full items-center justify-center"><Spinner size="lg" /></div>;
  }
  if (error || !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <ShieldAlert className="size-8 text-destructive" />
        <p className="text-sm text-muted-foreground">{error instanceof Error ? error.message : "Couldn't reach the coding sidecar."}</p>
      </div>
    );
  }
  return <iframe key={data.url} src={data.url} className="h-full w-full border-0" title="OpenCode" />;
}
