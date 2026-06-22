// MapsPanelContent — the active-panel body rendered inside LeftRail's
// children slot. Extracted from MapsPage to keep it under 400 LOC.
// Phase maps-discovery chunk-03.

import type { ViewportCenter } from "./api";
import { ExplorePanel } from "./panels/ExplorePanel";
import { DirectionsPanel } from "./panels/DirectionsPanel";
import { GuidesPanel } from "./panels/GuidesPanel";
import { MapSettingsPanel } from "./panels/MapSettingsPanel";
import { PinsPanel } from "./panels/PinsPanel";
import { RecentsList } from "./panels/RecentsList";
import type { PanelKind, PlaceResult, SavedPin } from "./types";
import type { RouteAlt } from "./use-directions";
import { useMapPrefs } from "./use-map-prefs";
import { useIncidents } from "./use-incidents";
import { useNavigation } from "./use-navigation";
import { NavigationBanner } from "./panels/NavigationBanner";
import { NavigationFooter } from "./panels/NavigationFooter";
import type { MutableRefObject } from "react";
import maplibregl from "maplibre-gl";

export function MapsPanelContent({
  activePanel,
  directionsTarget,
  directionsOrigin,
  directionsMode,
  viewportCenter,
  selectedPlace,
  recentsReloadKey,
  mapRef,
  onCategorySelect,
  onCloseDirections,
  onAltsChange,
  onStepFocus,
  onPinSelect,
  onPickDirections,
}: {
  activePanel: PanelKind;
  mapRef: MutableRefObject<maplibregl.Map | null>;
  directionsTarget: PlaceResult | null;
  directionsOrigin: PlaceResult | null;
  directionsMode: "auto" | "pedestrian" | "bicycle" | "hiking" | "mtb";
  viewportCenter: ViewportCenter | null;
  selectedPlace: PlaceResult | null;
  recentsReloadKey: number;
  onCategorySelect: (slug: string) => void;
  onCloseDirections: () => void;
  onAltsChange: (alts: RouteAlt[], idx: number) => void;
  onStepFocus: (coords: [number, number][] | null) => void;
  onPinSelect: (pin: SavedPin) => void;
  onPickDirections: (entry: { from: PlaceResult; to: PlaceResult; mode: "auto" | "pedestrian" | "bicycle" | "hiking" | "mtb" }) => void;
}): JSX.Element {
  const { prefs, setPref, resetPrefs } = useMapPrefs();
  useIncidents(mapRef, prefs.liveIncidents);
  const nav = useNavigation(mapRef);

  if (nav.state === "navigating" && nav.nextStep) {
    return (
      <div className="relative flex flex-col h-full">
        <NavigationBanner text={nav.nextStep.text} distanceM={nav.nextStep.distanceM} onStop={nav.stop} />
        <div className="flex-1" />
        <NavigationFooter remainingM={nav.remainingM} />
      </div>
    );
  }

  if (activePanel === "settings") {
    return (
      <MapSettingsPanel
        prefs={prefs}
        onChangePref={setPref}
        onReset={resetPrefs}
      />
    );
  }
  if (activePanel === "directions") {
    return (
      <>
        <DirectionsPanel
          destination={directionsTarget}
          origin={directionsOrigin}
          mode={directionsMode}
          viewportCenter={viewportCenter}
          onClose={onCloseDirections}
          onAltsChange={onAltsChange}
          onStepFocus={onStepFocus}
          onStartNavigation={nav.start}
        />
        <RecentsList
          variant="directions"
          reloadKey={recentsReloadKey}
          onPickDirections={onPickDirections}
        />
      </>
    );
  }
  if (activePanel === "guides") return <GuidesPanel />;
  if (activePanel === "pins") {
    return (
      <PinsPanel
        seedPlace={selectedPlace}
        seedCenter={viewportCenter}
        onSelect={onPinSelect}
      />
    );
  }
  return <ExplorePanel onSelectCategory={onCategorySelect} />;
}
