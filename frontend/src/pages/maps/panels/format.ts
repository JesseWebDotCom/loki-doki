/**
 * Tiny formatting helpers shared across Directions-panel pieces. Kept
 * in a separate file so RouteAltCard / TurnByTurnList / DirectionsPanel
 * all import from one source.
 */

/** `"NN min"` — always at least 1 min, rounded to the nearest minute. */
export function formatDuration(seconds: number): string {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours} hr` : `${hours} hr ${rem} min`;
}

/** `"HH:MM AM/PM"` — locale-formatted ETA (now + duration). */
export function formatEta(durationSeconds: number, now: Date = new Date()): string {
  const arrival = new Date(now.getTime() + durationSeconds * 1000);
  return arrival.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** `"N miles"` / `"N km"` — imperial unless `useMetric`. */
export function formatDistance(metres: number, useMetric = false): string {
  if (useMetric) {
    if (metres < 1000) return `${Math.round(metres)} m`;
    return `${(metres / 1000).toFixed(1)} km`;
  }
  const miles = metres * 0.000621371;
  if (miles < 0.1) return `${Math.round(metres * 3.28084)} ft`;
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
}

/** Locale-guess for imperial vs metric — defaults to imperial in en-US. */
export function prefersMetric(): boolean {
  if (typeof navigator === 'undefined') return false;
  const lang = (navigator.language || 'en-US').toLowerCase();
  return !lang.startsWith('en-us') && !lang.startsWith('en-gb');
}
