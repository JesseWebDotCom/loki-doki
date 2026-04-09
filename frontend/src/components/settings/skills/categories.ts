/**
 * Category derivation for skills.
 *
 * Skill manifests don't (yet) carry an explicit `category` field, so
 * we derive one from the skill_id prefix. This keeps the grid grouping
 * working with zero backend changes; if a manifest gains an explicit
 * category later, prefer that and fall through to this map.
 */
import {
  Wrench,
  Cloud,
  Film,
  Newspaper,
  BookOpen,
  Calculator,
  Search,
  Home,
  Smile,
  Utensils,
  Tv,
  Clock,
  type LucideIcon,
} from "lucide-react";

export interface CategoryMeta {
  label: string;
  Icon: LucideIcon;
}

const ID_TO_CATEGORY: Record<string, string> = {
  calculator: "math",
  unit_conversion: "math",
  datetime_local: "utilities",
  smarthome_mock: "smart_home",
  jokes: "fun",
  news_rss: "news",
  recipe_mealdb: "food",
  search_ddg: "search",
  knowledge_wiki: "reference",
  dictionary: "reference",
  tvshows_tvmaze: "entertainment",
};

const PREFIX_TO_CATEGORY: Array<[string, string]> = [
  ["weather_", "weather"],
  ["movies_", "entertainment"],
  ["tvshows_", "entertainment"],
  ["news_", "news"],
];

export const CATEGORIES: Record<string, CategoryMeta> = {
  weather: { label: "Weather", Icon: Cloud },
  entertainment: { label: "Entertainment", Icon: Film },
  news: { label: "News", Icon: Newspaper },
  reference: { label: "Reference", Icon: BookOpen },
  math: { label: "Math", Icon: Calculator },
  search: { label: "Search", Icon: Search },
  smart_home: { label: "Smart Home", Icon: Home },
  fun: { label: "Fun", Icon: Smile },
  food: { label: "Food", Icon: Utensils },
  utilities: { label: "Utilities", Icon: Clock },
  other: { label: "Other", Icon: Wrench },
};

const SKILL_ICON_OVERRIDES: Record<string, LucideIcon> = {
  tvshows_tvmaze: Tv,
};

export function categoryForSkill(skillId: string): string {
  if (ID_TO_CATEGORY[skillId]) return ID_TO_CATEGORY[skillId];
  for (const [prefix, cat] of PREFIX_TO_CATEGORY) {
    if (skillId.startsWith(prefix)) return cat;
  }
  return "other";
}

export function iconForSkill(skillId: string): LucideIcon {
  return (
    SKILL_ICON_OVERRIDES[skillId] ||
    CATEGORIES[categoryForSkill(skillId)].Icon
  );
}

