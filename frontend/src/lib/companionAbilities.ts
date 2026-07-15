import type { InstalledTool } from "@/hooks/useInstalledTools";

// Maps every user-visible companion chat tool to the app whose settings page
// hosts its toggle ("Companion abilities" section). Two shapes:
//
// - App-backed tools (standalone: false): the tool IS the app (youtube,
//   weather...). Toggling writes __chat_enabled so the app stays installed
//   while the companion loses the ability.
// - Standalone abilities (standalone: true): chat-only tools that ship with a
//   built-in app (play_music ships with Music). Toggling writes __enabled -
//   their only flag, carried over from when they were store "Extensions".
//
// Not listed here: core plumbing (tool.core, hidden everywhere) and the two
// admin-only integrations (search → Admin › Features, plex → Admin › Plex).

export interface AbilityMapping {
  toolId: string;
  /** APP_GROUPS app id whose settings page hosts the toggle. */
  hostAppId: string;
  standalone: boolean;
}

export const ABILITY_HOSTS: AbilityMapping[] = [
  // App-backed tools - toggle = __chat_enabled
  { toolId: "youtube",         hostAppId: "videos",         standalone: false },
  { toolId: "weather",         hostAppId: "weather",        standalone: false },
  { toolId: "news",            hostAppId: "news",           standalone: false },
  { toolId: "localNews",       hostAppId: "news",           standalone: false },
  { toolId: "recipes",         hostAppId: "recipes",        standalone: false },
  { toolId: "jokes",           hostAppId: "jokes",          standalone: false },
  { toolId: "holidays",        hostAppId: "holidays",       standalone: false },
  { toolId: "moonphase",       hostAppId: "moon-phase",     standalone: false },
  { toolId: "onthisday",       hostAppId: "on-this-day",    standalone: false },
  { toolId: "localEvents",     hostAppId: "local-events",   standalone: false },
  { toolId: "sports",          hostAppId: "sports",         standalone: false },
  { toolId: "shopping",        hostAppId: "shopping",       standalone: false },
  { toolId: "time",            hostAppId: "time",           standalone: false },
  { toolId: "unit_conversion", hostAppId: "unit-converter", standalone: false },
  { toolId: "tvshows",         hostAppId: "shows",          standalone: false },
  { toolId: "where-to-watch",  hostAppId: "where-to-watch", standalone: false },
  { toolId: "showtimes",       hostAppId: "showtimes",      standalone: false },
  { toolId: "home_inventory",  hostAppId: "home-inventory", standalone: false },
  { toolId: "homeAssistant",   hostAppId: "home-assistant", standalone: false },
  { toolId: "maps",            hostAppId: "maps",           standalone: false },
  { toolId: "coding",          hostAppId: "coding",         standalone: false },
  { toolId: "image_gen",       hostAppId: "imaging",        standalone: false },
  { toolId: "canvas",          hostAppId: "canvas",         standalone: false },
  // Standalone abilities - toggle = __enabled
  { toolId: "play_music",      hostAppId: "music",          standalone: true },
  { toolId: "curate_playlist", hostAppId: "music",          standalone: true },
  { toolId: "music_insights",  hostAppId: "music",          standalone: true },
  { toolId: "request_media",   hostAppId: "movies",         standalone: true },
  { toolId: "download_status", hostAppId: "movies",         standalone: true },
  { toolId: "video_gen",       hostAppId: "video",          standalone: true },
  { toolId: "document_edit",   hostAppId: "canvas",         standalone: true },
  { toolId: "saveToBookmarks", hostAppId: "bookmarks",      standalone: true },
  { toolId: "bookmarksLibrary", hostAppId: "bookmarks",     standalone: true },
  { toolId: "file_converter",  hostAppId: "converter",      standalone: true },
  { toolId: "knowledge",       hostAppId: "reference",      standalone: true },
  { toolId: "dictionary",      hostAppId: "reference",      standalone: true },
  { toolId: "medical",         hostAppId: "reference",      standalone: true },
  { toolId: "people_lookup",   hostAppId: "reverse-lookup", standalone: true },
  { toolId: "property_lookup", hostAppId: "reverse-lookup", standalone: true },
];

/** App ids that host at least one ability (need a settings page + gear link). */
export const ABILITY_HOST_APP_IDS = new Set(ABILITY_HOSTS.map((a) => a.hostAppId));

export interface AppAbility {
  toolId: string;
  name: string;
  description: string;
  /** Effective on/off state of the toggle. */
  enabled: boolean;
  /** Which flag the toggle writes: chat-enabled endpoint or the install flag. */
  endpoint: "chat-enabled" | "enabled";
  /** External services the ability contacts; empty = fully local. */
  dataSources: { name: string; domain: string }[];
}

/** Display-ready ability list for one app's settings page. */
export function abilitiesForApp(appId: string, tools: InstalledTool[] | null): AppAbility[] {
  if (!tools) return [];
  const byId = new Map(tools.map((t) => [t.id, t]));
  const out: AppAbility[] = [];
  for (const m of ABILITY_HOSTS) {
    if (m.hostAppId !== appId) continue;
    const tool = byId.get(m.toolId);
    if (!tool || tool.core) continue;
    out.push({
      toolId: tool.id,
      name: tool.name,
      description: tool.description ?? "",
      enabled: m.standalone ? tool.enabled : tool.enabled && tool.chatEnabled !== false,
      endpoint: m.standalone ? "enabled" : "chat-enabled",
      dataSources: (tool.dataSources ?? []).map((d) => ({ name: d.name, domain: d.domain })),
    });
  }
  return out;
}
