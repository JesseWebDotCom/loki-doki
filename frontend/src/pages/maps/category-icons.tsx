import { type ComponentType } from "react";
import {
  Building2Icon,
  CarIcon,
  CrossIcon,
  FuelIcon,
  GraduationCapIcon,
  HotelIcon,
  LandmarkIcon,
  MailboxIcon,
  MapPinIcon,
  PillIcon,
  ShoppingBagIcon,
  TrainFrontIcon,
  TreesIcon,
  UmbrellaIcon,
  UtensilsIcon,
} from "lucide-react";

export type IconStyle = {
  Icon: ComponentType<{ className?: string }>;
  bg: string;
  fg: string;
};

const RULES: Array<{ match: (category: string) => boolean; style: IconStyle }> = [
  {
    match: (c) =>
      c.startsWith("poi:amenity:restaurant") ||
      c.startsWith("poi:amenity:fast_food") ||
      c.startsWith("poi:amenity:cafe") ||
      c.startsWith("poi:amenity:bar") ||
      c.startsWith("poi:amenity:pub"),
    // design-ok(raw-palette-semantic): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: UtensilsIcon, bg: "bg-orange-500", fg: "text-white" },
  },
  {
    match: (c) =>
      c.startsWith("poi:tourism:hotel") ||
      c.startsWith("poi:tourism:motel") ||
      c.startsWith("poi:tourism:guest_house"),
    // design-ok(banned-palette): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: HotelIcon, bg: "bg-purple-500", fg: "text-white" },
  },
  {
    match: (c) => c.startsWith("poi:amenity:pharmacy"),
    // design-ok(raw-palette-semantic): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: PillIcon, bg: "bg-red-500", fg: "text-white" },
  },
  {
    match: (c) =>
      c.startsWith("poi:amenity:hospital") ||
      c.startsWith("poi:amenity:clinic") ||
      c.startsWith("poi:amenity:doctors") ||
      c.startsWith("poi:healthcare:"),
    // design-ok(raw-palette-semantic): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: CrossIcon, bg: "bg-red-500", fg: "text-white" },
  },
  {
    match: (c) =>
      c.startsWith("poi:amenity:school") ||
      c.startsWith("poi:amenity:college") ||
      c.startsWith("poi:amenity:university"),
    // design-ok(banned-palette): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: GraduationCapIcon, bg: "bg-indigo-500", fg: "text-white" },
  },
  {
    match: (c) => c.startsWith("poi:leisure:park") || c.startsWith("poi:boundary:national_park"),
    // design-ok(raw-palette-semantic): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: TreesIcon, bg: "bg-green-600", fg: "text-white" },
  },
  {
    match: (c) => c.startsWith("poi:natural:beach") || c.startsWith("poi:leisure:beach_resort"),
    // design-ok(raw-palette-semantic): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: UmbrellaIcon, bg: "bg-cyan-500", fg: "text-white" },
  },
  {
    match: (c) => c.startsWith("poi:amenity:fuel"),
    // design-ok(raw-palette-semantic): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: FuelIcon, bg: "bg-amber-500", fg: "text-white" },
  },
  {
    match: (c) => c.startsWith("poi:amenity:parking"),
    // design-ok(raw-palette-semantic): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: CarIcon, bg: "bg-blue-500", fg: "text-white" },
  },
  {
    match: (c) => c.startsWith("poi:amenity:atm") || c.startsWith("poi:amenity:bank"),
    // design-ok(raw-palette-semantic): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: LandmarkIcon, bg: "bg-slate-500", fg: "text-white" },
  },
  {
    match: (c) =>
      c.startsWith("poi:railway:station") ||
      c.startsWith("poi:public_transport:station") ||
      c.startsWith("poi:public_transport:stop_position") ||
      c.startsWith("poi:amenity:bus_station"),
    // design-ok(raw-palette-semantic): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: TrainFrontIcon, bg: "bg-blue-600", fg: "text-white" },
  },
  {
    match: (c) => c.startsWith("poi:shop:"),
    // design-ok(raw-palette-semantic): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: ShoppingBagIcon, bg: "bg-pink-500", fg: "text-white" },
  },
  {
    match: (c) => c === "postcode",
    // design-ok(raw-palette-semantic): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: MailboxIcon, bg: "bg-slate-500", fg: "text-white" },
  },
  {
    match: (c) => c.startsWith("poi:place:") || c.startsWith("poi:boundary:administrative"),
    // design-ok(raw-palette-semantic): POI category color data, sibling to poi-colors.ts allowlist
    style: { Icon: Building2Icon, bg: "bg-zinc-500", fg: "text-white" },
  },
];

// design-ok(raw-palette-semantic): POI category color data, sibling to poi-colors.ts allowlist
export const DEFAULT_ICON_STYLE: IconStyle = {
  Icon: MapPinIcon,
  bg: "bg-red-500",
  fg: "text-white",
};

export function iconStyleForCategory(category: string | null | undefined): IconStyle {
  if (!category) return DEFAULT_ICON_STYLE;
  for (const rule of RULES) {
    if (rule.match(category)) return rule.style;
  }
  return DEFAULT_ICON_STYLE;
}
