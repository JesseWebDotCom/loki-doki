import { useCallback, useState, type ReactNode } from "react";
import { Lock, type LucideIcon } from "lucide-react";
import type { PanelSection } from "@/components/shared/PanelLayout";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";
import { AppTabBar } from "@/components/shared/AppTabBar";
import { PageHeader } from "@/components/shared/PageHeader";
import { useAuth } from "@/context/AuthContext";

// THE app-settings layout, extracted from the YouTube settings page so every
// app's settings looks identical: PageHeader up top, collapsible left section
// sidebar (SettingsSidebar, same anatomy as Settings/Admin) on desktop, and a
// horizontal AppTabBar pill row on phones (app settings have few sections; the
// old hamburger-drawer was visually identical to the dock menu and read as a
// second mystery menu). Sections marked adminOnly render their content for
// admins and a locked notice for everyone else. Section state is internal by
// default; pass activeSection + onNavigate to drive it from a /:section? route
// param (YouTube, the generic /apps/:appId/settings page).

export interface AppSettingsSection extends PanelSection {
  content: ReactNode;
  /** Admins see the content; others see a locked notice. */
  adminOnly?: boolean;
}

interface AppSettingsShellProps {
  /** Collapse-preference key, e.g. "weather" → localStorage "weather.settingsSidebarCollapsed". */
  appId: string;
  title?: string;
  icon?: LucideIcon;
  gradient?: string;
  sections: AppSettingsSection[];
  /** Controlled mode (URL-driven): current section id. */
  activeSection?: string;
  /** Controlled mode: called with the section id to navigate to. */
  onNavigate?: (id: string) => void;
}

function AdminLockedNotice() {
  return (
    <p className="flex items-center gap-2 rounded-card border border-border/50 bg-background/50 px-4 py-3 text-sm text-muted-foreground">
      <Lock className="size-4 shrink-0" aria-hidden="true" />
      This section is managed by an admin.
    </p>
  );
}

export function AppSettingsShell({ appId, title = "Settings", icon, gradient, sections, activeSection, onNavigate }: AppSettingsShellProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const collapseKey = `${appId}.settingsSidebarCollapsed`;

  const [internalSection, setInternalSection] = useState(sections[0]?.id ?? "");
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(collapseKey) === "1");
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(collapseKey, next ? "1" : "0");
      return next;
    });
  }, [collapseKey]);

  const current = activeSection ?? internalSection;
  const go = useCallback(
    (id: string) => {
      if (onNavigate) onNavigate(id);
      else setInternalSection(id);
    },
    [onNavigate],
  );

  const active = sections.find((s) => s.id === current) ?? sections[0];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader title={title} icon={icon} gradient={gradient} className="px-4 pt-6 pb-5 sm:px-6 lg:px-8" />

      {/* Phone: sections as a horizontal pill row (one row, scrolls; never a drawer). */}
      {sections.length > 1 && (
        <AppTabBar
          className="mx-4 mb-3 shrink-0 md:hidden"
          tabs={sections.map((s) => ({ id: s.id, label: s.label, icon: s.icon }))}
          value={active?.id ?? ""}
          onChange={go}
        />
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SettingsSidebar
          className="hidden md:flex"
          sections={sections}
          activeSection={active?.id ?? ""}
          onNavigate={go}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapsed}
        />

        <div className="min-w-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6 lg:px-8">
          {active && (active.adminOnly && !isAdmin ? <AdminLockedNotice /> : active.content)}
        </div>
      </div>
    </div>
  );
}
