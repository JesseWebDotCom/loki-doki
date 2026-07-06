import { useCallback } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Bot } from "lucide-react";
import { AppSettingsShell, type AppSettingsSection } from "@/components/shared/AppSettingsShell";
import { CompanionAbilitiesCard } from "@/components/shared/CompanionAbilitiesCard";
import { APP_GROUPS } from "@/lib/appCategories";

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

  const sections: AppSettingsSection[] = [
    { id: "companion", label: "Companion", icon: Bot, content: <CompanionAbilitiesCard appId={app.id} /> },
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
