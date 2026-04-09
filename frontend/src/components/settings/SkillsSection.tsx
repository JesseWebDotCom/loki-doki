/**
 * SkillsSection — compact, searchable, category-grouped skill grid.
 *
 * Renders the same data on the admin page and the user settings page;
 * the difference is purely whether the detail dialog exposes the
 * Global (admin) tier as editable or read-only, and whether the
 * admin-only Test panel is shown.
 *
 * Layout: search box → category sections → tile grid. Click a tile
 * to open SkillDetailDialog with the full config form + (admin) test
 * panel. The tile grid replaces the old vertical stack of full-width
 * cards, which got unwieldy as the catalog grew.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Wrench, Search } from "lucide-react";
import { listSkills, type SkillSummary } from "../../lib/api";
import { useAuth } from "../../auth/useAuth";
import SkillTile from "./skills/SkillTile";
import SkillDetailDialog from "./skills/SkillDetailDialog";
import { CATEGORIES, categoryForSkill } from "./skills/categories";

interface Props {
  /** Show the per-skill admin test panel inside the detail dialog.
   *  Off by default — only the dedicated admin-page mount enables it,
   *  so a user with admin role visiting personal Settings doesn't see
   *  the test affordance there. */
  enableTesting?: boolean;
}

const SkillsSection: React.FC<Props> = ({ enableTesting = false }) => {
  const { currentUser } = useAuth();
  const isAdmin = currentUser?.role === "admin";
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = async () => {
    try {
      const res = await listSkills();
      setSkills(res.skills || []);
    } catch {
      setSkills([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => {
      const hay = [
        s.name,
        s.skill_id,
        s.description,
        ...(s.intents || []),
        ...(s.examples || []),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [skills, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, SkillSummary[]>();
    for (const s of filtered) {
      const cat = categoryForSkill(s.skill_id);
      const list = map.get(cat) || [];
      list.push(s);
      map.set(cat, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return Array.from(map.keys())
      .map((c) => ({ key: c, meta: CATEGORIES[c], skills: map.get(c)! }))
      .sort((a, b) => a.meta.label.localeCompare(b.meta.label));
  }, [filtered]);

  // Re-read from the freshly-reloaded list so the open dialog reflects
  // edits immediately (toggle, saved fields).
  const selected = selectedId
    ? skills.find((s) => s.skill_id === selectedId) || null
    : null;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 border-b border-border/10 pb-4">
        <Wrench className="text-primary w-5 h-5" />
        <h2 className="text-xl font-bold tracking-tight">Skills</h2>
        <span className="text-[10px] font-bold text-muted-foreground bg-muted/10 px-2 py-0.5 rounded-md border border-border/20 ml-2">
          {isAdmin ? "ADMIN" : "USER"}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Configure server-wide credentials (admin) and your personal
        preferences for each skill. Click any skill to view details
        {isAdmin ? " or run a test prompt against it." : "."}
      </p>

      <div className="relative">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills…"
          className="w-full bg-card/40 border border-border/40 rounded-xl pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:border-primary/50"
        />
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">No skills match.</p>
      ) : (
        <div className="space-y-6">
          {grouped.map(({ key, meta, skills: list }) => (
            <section key={key} className="space-y-3">
              <div className="flex items-center gap-2">
                <meta.Icon size={14} className="text-muted-foreground" />
                <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  {meta.label}
                </h3>
                <span className="text-[10px] text-muted-foreground/60">
                  {list.length}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {list.map((s) => (
                  <SkillTile
                    key={s.skill_id}
                    skill={s}
                    onClick={() => setSelectedId(s.skill_id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {selected && (
        <SkillDetailDialog
          skill={selected}
          isAdmin={isAdmin}
          enableTesting={enableTesting && isAdmin}
          open={true}
          onOpenChange={(o) => !o && setSelectedId(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
};

export default SkillsSection;
