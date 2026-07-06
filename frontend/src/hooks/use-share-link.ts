// Reusable share-link action: native share sheet on mobile, clipboard+toast fallback
// everywhere else. Generalized from maps/use-share-place.ts.
import { toast } from "@/lib/toast";

export function useShareLink() {
  async function shareLink(url: string, opts?: { label?: string }): Promise<void> {
    const label = opts?.label ?? "Link";
    if (navigator.share) {
      try {
        await navigator.share({ url });
        return;
      } catch (err) {
        // AbortError = user cancelled the share sheet; not an error worth surfacing.
        if (err instanceof Error && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success(`${label} copied`);
    } catch {
      toast.error("Could not copy link");
    }
  }

  return { shareLink };
}
