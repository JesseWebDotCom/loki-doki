import { useEffect, useState } from "react";

import type { ViewportCenter } from "./api";

export type LocationStatus = "pending" | "granted" | "denied" | "unsupported";

export interface UserLocationState {
  location: ViewportCenter | null;
  status: LocationStatus;
}

/**
 * Request the browser's geolocation on mount and watch updates. Returns
 * both the latest fix and a coarse status so the UI can surface whether
 * the proximity bias is active (`granted`), being asked (`pending`),
 * refused (`denied`), or unavailable (`unsupported`).
 */
export function useUserLocation(): UserLocationState {
  const [state, setState] = useState<UserLocationState>({
    location: null,
    status: "pending",
  });

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setState({ location: null, status: "unsupported" });
      return undefined;
    }
    const id = navigator.geolocation.watchPosition(
      (position) => {
        setState({
          location: { lat: position.coords.latitude, lon: position.coords.longitude },
          status: "granted",
        });
      },
      (error) => {
        setState({
          location: null,
          status: error.code === error.PERMISSION_DENIED ? "denied" : "unsupported",
        });
      },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  return state;
}
