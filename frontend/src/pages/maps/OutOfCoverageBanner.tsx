import { Link } from "react-router-dom";
import { MapPinned } from "lucide-react";

/** Shown when regions ARE installed but the current view is outside all of them. */
export function OutOfCoverageBanner(): JSX.Element {
  return (
    <div className="rounded-2xl border border-amber-300/60 bg-amber-50/95 px-4 py-2 text-sm text-amber-950 shadow-(--shadow-md) dark:border-amber-700/70 dark:bg-amber-950/85 dark:text-amber-100">
      You&apos;re outside your installed regions, so the map is showing the low-detail overview layer.
    </div>
  );
}

/** Shown when NO regions are installed at all — the map has no usable data yet. */
export function NoRegionsNotice(): JSX.Element {
  return (
    <div className="grid gap-2 rounded-2xl border border-border/70 bg-card p-4 text-center shadow-(--shadow-md)">
      <div className="mx-auto flex size-9 items-center justify-center rounded-full bg-muted">
        <MapPinned className="size-4 text-muted-foreground" />
      </div>
      <h2 className="text-sm font-semibold">No map regions installed</h2>
      <p className="text-xs text-muted-foreground">
        Maps, place search, and directions need a downloaded region. You&apos;re seeing the
        low-detail world overview until you add one.
      </p>
      <Link
        to="/admin/features"
        className="mt-1 inline-flex items-center justify-center rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Download a region
      </Link>
    </div>
  );
}
