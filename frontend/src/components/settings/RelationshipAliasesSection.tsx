import React from "react";

import type { SettingsData } from "../../lib/api-types";

type Props = {
  settings: SettingsData | null;
  setSettings: React.Dispatch<React.SetStateAction<SettingsData | null>>;
};

const RelationshipAliasesSection: React.FC<Props> = ({ settings, setSettings }) => {
  const aliases = settings?.relationship_aliases ?? {};
  const canonicalKeys = Object.keys(aliases).sort();

  return (
    <div className="space-y-4 rounded-xl border border-border/30 bg-card/40 p-4">
      <div className="space-y-1">
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Relationship Vocabulary
        </div>
        <p className="text-xs text-muted-foreground">
          These aliases help pre-resolve people mentions like &quot;my mom&quot; or &quot;my bro&quot; before the decomposer prompt is built.
        </p>
      </div>
      <div className="grid gap-3">
        {canonicalKeys.map((canonical) => (
          <label key={canonical} className="grid gap-1">
            <span className="text-xs font-semibold capitalize text-foreground">{canonical}</span>
            <textarea
              rows={2}
              value={(aliases[canonical] ?? []).join(", ")}
              onChange={(e) => {
                if (!settings) return;
                const values = e.target.value
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean);
                setSettings({
                  ...settings,
                  relationship_aliases: {
                    ...settings.relationship_aliases,
                    [canonical]: values,
                  },
                });
              }}
              disabled={!settings}
              className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-xs text-foreground outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/5 disabled:opacity-50"
            />
          </label>
        ))}
      </div>
    </div>
  );
};

export default RelationshipAliasesSection;
