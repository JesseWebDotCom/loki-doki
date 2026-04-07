import React, { useEffect, useState } from "react";
import { User, Check, RotateCcw, Save } from "lucide-react";
import {
  listCharacters,
  setActiveCharacter,
  setCharacterOverride,
  clearCharacterOverride,
  type CharacterRow,
} from "../../lib/api";

/**
 * Settings → Characters section.
 *
 * Phase 1 user-facing slice. Lists every catalog character (admin-
 * managed) merged with this user's overrides, lets the user pick an
 * active character, and lets them override the behavior_prompt
 * locally without touching the catalog. Avatar customization and the
 * full Character Playground come in Phase 3.
 */
const CharactersSection: React.FC = () => {
  const [characters, setCharacters] = useState<CharacterRow[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<string>("");
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [savedPrompt, setSavedPrompt] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void load();
  }, []);

  const load = async () => {
    try {
      const res = await listCharacters();
      setCharacters(res.characters);
      setActiveId(res.active_character_id);
      const active = res.characters.find(
        (c) => c.id === res.active_character_id,
      );
      setDraftPrompt(active?.behavior_prompt ?? "");
    } catch {
      // backend not ready yet
    } finally {
      setLoading(false);
    }
  };

  const handlePick = async (id: number) => {
    try {
      await setActiveCharacter(id);
      setActiveId(id);
      const picked = characters.find((c) => c.id === id);
      setDraftPrompt(picked?.behavior_prompt ?? "");
    } catch {
      /* ignore */
    }
  };

  const handleSavePrompt = async () => {
    if (activeId == null) return;
    setSavingPrompt(true);
    try {
      const updated = await setCharacterOverride(activeId, {
        behavior_prompt: draftPrompt,
      });
      setCharacters((prev) =>
        prev.map((c) => (c.id === activeId ? updated : c)),
      );
      setSavedPrompt(true);
      setTimeout(() => setSavedPrompt(false), 1500);
    } catch {
      /* ignore */
    } finally {
      setSavingPrompt(false);
    }
  };

  const handleResetPrompt = async () => {
    if (activeId == null) return;
    try {
      await clearCharacterOverride(activeId);
      await load();
    } catch {
      /* ignore */
    }
  };

  const active = characters.find((c) => c.id === activeId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 border-b border-border/10 pb-4">
        <User className="text-primary w-5 h-5" />
        <h2 className="text-xl font-bold tracking-tight">Character</h2>
        <span className="text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-md border border-primary/20 ml-2">
          TIER 2
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Pick the persona LokiDoki adopts in conversation. Admins manage the
        global catalog; you can override the behavior prompt just for
        yourself.
      </p>

      {loading ? (
        <div className="text-xs text-muted-foreground">Loading characters…</div>
      ) : characters.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No characters available. Ask an admin to create one.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {characters.map((c) => {
            const isActive = c.id === activeId;
            return (
              <button
                key={c.id}
                onClick={() => handlePick(c.id)}
                className={`text-left p-4 rounded-xl border transition-all ${
                  isActive
                    ? "bg-primary/10 border-primary/40 shadow-m2"
                    : "bg-card/50 border-border/30 hover:border-border/60"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="text-sm font-bold">{c.name}</div>
                  {isActive && <Check className="w-4 h-4 text-primary" />}
                </div>
                <div className="text-[11px] text-muted-foreground line-clamp-2">
                  {c.description || "No description."}
                </div>
                <div className="mt-2 flex items-center gap-1 text-[10px] font-mono text-muted-foreground/80">
                  <span className="px-1.5 py-0.5 rounded bg-muted/40">
                    {c.source}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-muted/40">
                    {c.avatar_style}
                  </span>
                  {c.has_user_overrides && (
                    <span className="px-1.5 py-0.5 rounded bg-primary/15 text-primary">
                      customized
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {active && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
              Behavior Prompt — {active.name}
            </label>
            {active.has_user_overrides && (
              <button
                onClick={handleResetPrompt}
                className="text-[10px] font-bold text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                <RotateCcw size={10} /> Reset to catalog
              </button>
            )}
          </div>
          <textarea
            value={draftPrompt}
            onChange={(e) => setDraftPrompt(e.target.value)}
            rows={4}
            className="w-full bg-card/50 border border-border/50 rounded-xl p-4 focus:outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all text-sm font-medium resize-none"
          />
          <div className="flex justify-end">
            <button
              onClick={handleSavePrompt}
              disabled={savingPrompt || draftPrompt === active.behavior_prompt}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-xs transition-all ${
                savedPrompt
                  ? "bg-green-500/20 text-green-400 border border-green-500/30"
                  : "bg-primary text-white hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
              }`}
            >
              {savedPrompt ? <Check size={14} /> : <Save size={14} />}
              {savedPrompt ? "Saved" : "Save override"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default CharactersSection;
