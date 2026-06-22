// Phase maps-skill chunk-06: navigation bottom strip — remaining distance + ETA.
export function NavigationFooter({ remainingM }: { remainingM: number }): JSX.Element {
  const km = (remainingM / 1000).toFixed(1);
  const etaMin = Math.round(remainingM / 833); // ~50 km/h average
  const etaStr = etaMin < 60 ? `${etaMin} min` : `${Math.floor(etaMin / 60)}h ${etaMin % 60}m`;
  return (
    <div className="absolute bottom-0 left-0 right-0 z-30 flex items-center justify-between bg-background/90 backdrop-blur-sm border-t border-border/60 px-4 py-2 text-sm">
      <span className="font-semibold">{km} km remaining</span>
      <span className="text-muted-foreground">ETA: {etaStr}</span>
    </div>
  );
}
