// Phase maps-skill chunk-06: top navigation banner — next maneuver + distance.
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export function NavigationBanner({
  text,
  distanceM,
  onStop,
}: {
  text: string;
  distanceM: number;
  onStop: () => void;
}): JSX.Element {
  const dist = distanceM >= 1000
    ? `${(distanceM / 1000).toFixed(1)} km`
    : `${Math.round(distanceM)} m`;
  return (
    <div className={cn(
      "absolute left-0 right-0 top-0 z-30 flex items-center gap-3 bg-primary px-4 py-3 text-primary-foreground shadow-lg",
    )}>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide opacity-70">{dist}</p>
        <p className="truncate text-sm font-semibold">{text}</p>
      </div>
      <Button type="button" variant="ghost" size="icon" onClick={onStop} aria-label="End navigation"
        className="size-8 text-primary-foreground hover:bg-white/20 hover:text-primary-foreground">
        <XIcon className="size-5" />
      </Button>
    </div>
  );
}
