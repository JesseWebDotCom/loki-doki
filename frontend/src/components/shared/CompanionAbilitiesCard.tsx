import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Globe, Lock, Sparkles } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useInstalledTools } from "@/hooks/useInstalledTools";
import { abilitiesForApp, type AppAbility } from "@/lib/companionAbilities";
import { ToggleRow } from "@/components/shared/ToggleRow";
import { toast } from "@/lib/toast";

// "Companion abilities" section for an app's settings page: one toggle per
// chat tool the app ships. Toggles are household-global and admin-only;
// non-admins see the current state with a lock note. App-backed tools write
// the chat-enabled flag (app stays installed), standalone abilities write
// their install flag - abilitiesForApp decides via `endpoint`.

export function CompanionAbilitiesCard({ appId }: { appId: string }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { tools } = useInstalledTools();
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = user?.role === "admin";

  const abilities = abilitiesForApp(appId, tools);
  if (abilities.length === 0) return null;

  async function toggle(a: AppAbility) {
    if (!isAdmin || busy) return;
    setBusy(a.toolId);
    try {
      const path = a.endpoint === "chat-enabled" ? "chat-enabled" : "enabled";
      const res = await fetch(`/api/tools/${a.toolId}/${path}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !a.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["tools"] });
      toast.success(!a.enabled ? `${a.name} enabled` : `${a.name} turned off`);
    } catch {
      toast.error(`Couldn't update ${a.name}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <Sparkles className="size-4 text-brand" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Companion abilities</h3>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        What this app lets the companion do in chat, for everyone in the household.
      </p>
      <div className="space-y-2">
        {abilities.map((a) => (
          <ToggleRow
            key={a.toolId}
            title={a.name}
            description={a.description}
            checked={a.enabled}
            disabled={!isAdmin || busy === a.toolId}
            onCheckedChange={() => void toggle(a)}
            chip={
              a.dataSources.length > 0 ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-info/15 px-1.5 py-0.5 text-[10px] font-medium text-info"
                  title={`Connects to ${a.dataSources.map((d) => d.domain).join(", ")}`}
                >
                  <Globe className="size-2.5" aria-hidden="true" />
                  online
                </span>
              ) : undefined
            }
          />
        ))}
      </div>
      {!isAdmin && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Lock className="size-3" aria-hidden="true" />
          These switches are managed by an admin.
        </p>
      )}
    </section>
  );
}
