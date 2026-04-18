/**
 * Shared types for the Directions panel and its child components.
 *
 * Mirrors the API shape returned by POST /api/v1/maps/route — the hook
 * normalises raw fetch output into these structures so every panel
 * piece reads the same model.
 */
import type { PlaceResult } from '../types';

export type ModeId = 'auto' | 'pedestrian' | 'bicycle';

export interface AvoidState {
  highways: boolean;
  tolls: boolean;
  ferries: boolean;
}

export interface WaypointRow {
  /** Stable local id — survives reorder and deletion. */
  rid: string;
  /** User-typed text / resolved place title. */
  text: string;
  /** Resolved coordinates. null until a dropdown pick commits. */
  place: PlaceResult | null;
  /** True for the first row ("From"). Used to seed "My Location". */
  isOrigin?: boolean;
}

export interface DirectionsForm {
  mode: ModeId;
  rows: WaypointRow[];
  avoid: AvoidState;
}

/** Normalised Valhalla maneuver, ready for the turn-by-turn list. */
export interface Maneuver {
  instruction: string;
  /** Metres along this step. */
  distance_m: number;
  /** Seconds along this step. */
  duration_s: number;
  /** Valhalla maneuver type (numeric code). */
  type: number;
  begin_shape_index: number;
  end_shape_index: number;
}

export interface RouteAlt {
  /** Seconds for the whole route. */
  duration_s: number;
  /** Metres for the whole route. */
  distance_m: number;
  /** Encoded polyline6 shape string. */
  geometry: string;
  /** Decoded [lng, lat] pairs — hydrated client-side. */
  coords: [number, number][];
  /** Present only for the primary route; empty for alternates. */
  maneuvers: Maneuver[];
  /** Joined narrative for one-shot TTS readout. Primary only. */
  instructions_text: string[];
  /** True when this alternate has the shortest duration. */
  is_fastest: boolean;
}

export interface DirectionsRequestBody {
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  waypoints?: { lat: number; lon: number }[];
  profile: ModeId;
  alternates: number;
  avoid: AvoidState;
}

export interface DirectionsResponseEnvelope {
  routes: {
    duration_s: number;
    distance_m: number;
    geometry: string;
    profile: string;
    legs: { steps: Maneuver[] }[];
  }[];
  instructions_text: string[];
  alternates: { duration_s: number; distance_m: number; geometry: string }[];
  mechanism_used: 'valhalla' | 'osrm';
  offline?: boolean;
}
