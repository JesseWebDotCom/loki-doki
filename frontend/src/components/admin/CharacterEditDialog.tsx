import React, { useEffect, useState } from "react";
import { X, Save } from "lucide-react";
import {
  adminCreateCharacter,
  adminPatchCharacter,
  type AdminCharacterRow,
} from "../../lib/api";

/**
 * Modal form for creating or editing a catalog character.
 *
 * Phase-1 admin slice: name, description, behavior_prompt, avatar
 * style/seed. Voice and wakeword bindings will be added when Phase 2
 * lands the asset registry. Builtin rows are not editable here — the
 * route layer enforces copy-on-write, so editing one will produce a
 * new admin-source row; the parent reloads the list afterward.
 */
type Props = {
  initial: AdminCharacterRow | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
};

const STYLES: AdminCharacterRow["avatar_style"][] = [
  "avataaars",
  "bottts",
  "toon-head",
];

const CharacterEditDialog: React.FC<Props> = ({ initial, onClose, onSaved }) => {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [behaviorPrompt, setBehaviorPrompt] = useState("");
  const [avatarStyle, setAvatarStyle] = useState<AdminCharacterRow["avatar_style"]>(
    "bottts",
  );
  const [avatarSeed, setAvatarSeed] = useState("");
  const [phoneticName, setPhoneticName] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setDescription(initial.description);
      setBehaviorPrompt(initial.behavior_prompt);
      setAvatarStyle(initial.avatar_style);
      setAvatarSeed(initial.avatar_seed);
      setPhoneticName(initial.phonetic_name);
    } else {
      setName("");
      setDescription("");
      setBehaviorPrompt("");
      setAvatarStyle("bottts");
      setAvatarSeed("");
      setPhoneticName("");
    }
    setErr(null);
  }, [initial]);

  const handleSave = async () => {
    if (!name.trim()) {
      setErr("Name is required");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const body = {
        name: name.trim(),
        description,
        phonetic_name: phoneticName,
        behavior_prompt: behaviorPrompt,
        avatar_style: avatarStyle,
        avatar_seed: avatarSeed,
      };
      if (initial) {
        await adminPatchCharacter(initial.id, body);
      } else {
        await adminCreateCharacter(body);
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl border border-border/40 bg-background shadow-m4 p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-border/20 pb-3">
          <h3 className="text-lg font-bold">
            {initial ? `Edit: ${initial.name}` : "New Character"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {initial?.source === "builtin" && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-[11px] text-amber-300">
            Builtin characters can&apos;t be edited in place. Saving will create
            a new admin-source copy with your changes.
          </div>
        )}

        {err && (
          <div className="rounded-lg border border-red-400/30 bg-red-400/5 p-3 text-[11px] text-red-300">
            {err}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-card/50 border border-border/40 rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Phonetic Name
            </label>
            <input
              value={phoneticName}
              onChange={(e) => setPhoneticName(e.target.value)}
              placeholder="Optional — for TTS pronunciation"
              className="w-full bg-card/50 border border-border/40 rounded-md px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Description (tagline)
          </label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full bg-card/50 border border-border/40 rounded-md px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Behavior Prompt
          </label>
          <textarea
            value={behaviorPrompt}
            onChange={(e) => setBehaviorPrompt(e.target.value)}
            rows={5}
            className="w-full bg-card/50 border border-border/40 rounded-md px-3 py-2 text-sm font-medium resize-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Avatar Style
            </label>
            <select
              value={avatarStyle}
              onChange={(e) =>
                setAvatarStyle(e.target.value as AdminCharacterRow["avatar_style"])
              }
              className="w-full bg-card/50 border border-border/40 rounded-md px-3 py-2 text-sm"
            >
              {STYLES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Avatar Seed
            </label>
            <input
              value={avatarSeed}
              onChange={(e) => setAvatarSeed(e.target.value)}
              className="w-full bg-card/50 border border-border/40 rounded-md px-3 py-2 text-sm font-mono"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-md border border-border/40 text-xs font-bold hover:bg-card/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-xs font-bold hover:bg-primary/90 disabled:opacity-50"
          >
            <Save size={12} />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CharacterEditDialog;
