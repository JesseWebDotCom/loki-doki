import { useCallback } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Bot, MonitorPlay, ShieldCheck, Music4 } from "lucide-react";
import { AppSettingsShell, type AppSettingsSection } from "@/components/shared/AppSettingsShell";
import { CompanionAbilitiesCard } from "@/components/shared/CompanionAbilitiesCard";
import { ToolConfigFields } from "@/components/shared/ToolConfigFields";
import { PlexConnectCard } from "@/components/media/PlexConnectCard";
import { MusicLyricsSettings } from "@/components/music/MusicLyricsSettings";
import { APP_GROUPS } from "@/lib/appCategories";

// Apps whose global config (API keys, etc.) used to only live on the generic
// Admin -> Apps -> App Settings list. Maps this page's appId to the tool id
// whose configSchema should render inline here, admin-only.
const ADMIN_CONFIG_TOOL_ID: Record<string, string> = {
  "where-to-watch": "where-to-watch",
  "news": "localNews",
  "local-events": "localEvents",
};

// Extra per-app sections beyond the shared Companion/Admin pair. Shows gets the personal
// Plex link because that's what its watchlist + watched-progress sync run through (Movies
// has the same card on its own bespoke settings page).
const EXTRA_SECTIONS: Record<string, AppSettingsSection[]> = {
  music: [
    {
      id: "lyrics",
      label: "Lyrics",
      icon: Music4,
      content: <MusicLyricsSettings />,
    },
  ],
  shows: [
    {
      id: "plex",
      label: "Plex",
      icon: MonitorPlay,
      content: (
        <section className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Connect your Plex account to play your library and sync your watchlist and watched episodes.
          </p>
          <PlexConnectCard />
          <p className="text-xs text-muted-foreground">
            Your watchlist changes and watched-state sync to your own Plex account. The shared Plex server is set up by an admin.
          </p>
        </section>
      ),
    },
  ],
};

// Generic per-app settings page at /apps/:appId/settings/:section? for apps
// that have no bespoke settings route. Today it hosts the Companion abilities
// toggles; app-specific preferences can grow their own sections here. Apps
// with their own settings page embed CompanionAbilitiesCard there instead.
export function AppSettingsGenericPage() {
  const { appId = "", section } = useParams();
  const navigate = useNavigate();
  const go = useCallback(
    (id: string) => navigate(`/apps/${appId}/settings/${id}`, { replace: true }),
    [navigate, appId],
  );

  const app = APP_GROUPS.flatMap((g) => g.apps).find((a) => a.id === appId);
  if (!app) return <Navigate to="/" replace />;

  const adminToolId = ADMIN_CONFIG_TOOL_ID[app.id];
  const extra = EXTRA_SECTIONS[app.id] ?? [];
  const sections: AppSettingsSection[] = [
    ...extra,
    { id: "companion", label: "Companion", icon: Bot, content: <CompanionAbilitiesCard appId={app.id} /> },
    ...(adminToolId
      ? [{ id: "admin", label: "Admin", icon: ShieldCheck, adminOnly: true, content: <ToolConfigFields toolId={adminToolId} /> }]
      : []),
  ];

  return (
    <AppSettingsShell
      appId={app.id}
      title={`${app.label} Settings`}
      icon={app.icon}
      gradient={app.gradient}
      sections={sections}
      activeSection={section ?? sections[0]!.id}
      onNavigate={go}
    />
  );
}
