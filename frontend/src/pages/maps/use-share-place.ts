// Phase maps-skill chunk-05: share place to clipboard.
// Builds a geo: URI and a Loki Doki deep-link, copies both, fires a toast.
import { toast } from "@/lib/toast";

export function sharePlaceToClipboard(place: {
  title: string;
  lat: number;
  lon: number;
}): void {
  const name = encodeURIComponent(place.title);
  const geoUri = `geo:${place.lat.toFixed(6)},${place.lon.toFixed(6)}?q=${name}`;
  const deepLink = `${window.location.origin}/maps?focus=${place.lat.toFixed(6)},${place.lon.toFixed(6)}&zoom=16`;
  void navigator.clipboard
    .writeText(`${geoUri}\n${deepLink}`)
    .then(() => toast.success("Link copied"))
    .catch(() => toast.error("Could not copy link"));
}
