import { useCallback } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Bot, ShieldCheck } from "lucide-react";
import { AppSettingsShell, type AppSettingsSection } from "@/components/shared/AppSettingsShell";
import { CompanionAbilitiesCard } from "@/components/shared/CompanionAbilitiesCard";
import { ToolConfigFields } from "@/components/shared/ToolConfigFields";
import { APP_GROUPS } from "@/lib/appCategories";

// Apps whose global config (API keys, etc.) used to only live on the generic
// Admin -> Apps -> App Settings list. Maps this page's appId to the tool id
// whose configSchema should render inline here, admin-only.
const ADMIN_CONFIG_TOOL_ID: Record<string, string> = {
  "where-to-watch": "where-to-watch",
  "news": "localNews",
  "local-events": "localEvents",
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
  const sections: AppSettingsSection[] = [
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
      activeSection={section ?? "companion"}
      onNavigate={go}
    />
  );
}
