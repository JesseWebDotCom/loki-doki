import React, { useEffect, useMemo, useState } from "react";
import { X, Save, Sparkles, RefreshCw } from "lucide-react";
import {
  adminCreateCharacter,
  adminPatchCharacter,
  adminResetCharacterToBuiltin,
  type AdminCharacterRow,
} from "../../lib/api";
import Avatar, { type AvatarStyle } from "../character/Avatar";
import RiggedDicebearAvatar from "../character/RiggedDicebearAvatar";
import type { HeadTiltState } from "../character/useHeadTilt";
import SchemaField from "../character/SchemaField";
import {
  COMMON_KEYS,
  filterOptionsForStyle,
  getStyleFields,
} from "../character/styleSchemas";

/**
 * Character Playground (Phase 3 — schema-driven).
 *
 * Three-pane layout:
 *   LEFT  (sticky) : large preview + style picker + seed controls
 *   MIDDLE          : prompt editor (name / description / behavior)
 *   RIGHT (scroll)  : ALL DiceBear options for the active style,
 *                    grouped Common / Style-specific, rendered
 *                    dynamically from each style's JSON-schema
 *
 * Why schema-driven:
 *   Avataaars has ~30 options (top, eyes, mouth, accessories,
 *   facial hair, clothing, …); bottts has a different ~20; toon-head
 *   has its own ~20. Hardcoding three control sets would be a
 *   maintenance graveyard, AND would lock us in if we add styles
 *   later. Instead we read each style's ``schema.js`` at module
 *   load and render whatever it declares. Adding a fourth style
 *   requires only an entry in ``styleSchemas.ts``.
 *
 * Why options are filtered to the current style on every render:
 *   Switching from avataaars → toon-head leaves keys like ``top``
 *   in the option dict. DiceBear silently produces a blank SVG when
 *   it sees an option not in the schema (this was the v1 toon-head
 *   bug). ``filterOptionsForStyle`` strips them at the boundary, so
 *   the preview never goes blank and the saved row only contains
 *   options valid for its style.
 */
type Props = {
  initial: AdminCharacterRow | null;
  onClose: () => void;
  onSaved: () => void;
};

const STYLES: AvatarStyle[] = ["avataaars", "bottts", "toon-head"];

const randomSeed = () =>
  Math.random().toString(36).slice(2, 10) +
  Math.random().toString(36).slice(2, 6);

const CharacterPlayground: React.FC<Props> = ({ initial, onClose, onSaved }) => {
  // ----- prompt fields -----
  const [name, setName] = useState("");
  const [phoneticName, setPhoneticName] = useState("");
  const [description, setDescription] = useState("");
  const [behaviorPrompt, setBehaviorPrompt] = useState("");
  // ----- avatar -----
  const [style, setStyle] = useState<AvatarStyle>("bottts");
  const [seed, setSeed] = useState(randomSeed());
  const [optionsByStyle, setOptionsByStyle] = useState<
    Record<AvatarStyle, Record<string, unknown>>
  >({
    avataaars: {},
    bottts: {},
    "toon-head": {},
  });
  // ----- animation preview -----
  const [tiltState, setTiltState] = useState<HeadTiltState>("idle");
  const [manualTilt, setManualTilt] = useState<number | null>(null);
  // ----- io -----
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setPhoneticName(initial.phonetic_name);
      setDescription(initial.description);
      setBehaviorPrompt(initial.behavior_prompt);
      setStyle(initial.avatar_style);
      setSeed(initial.avatar_seed || randomSeed());
      // Pre-load saved options into the active style's slot.
      setOptionsByStyle({
        avataaars: {},
        bottts: {},
        "toon-head": {},
        [initial.avatar_style]: { ...(initial.avatar_config ?? {}) },
      });
    } else {
      setName("");
      setPhoneticName("");
      setDescription("");
      setBehaviorPrompt("");
      setStyle("bottts");
      setSeed(randomSeed());
      setOptionsByStyle({ avataaars: {}, bottts: {}, "toon-head": {} });
    }
    setErr(null);
  }, [initial]);

  // Always-current option dict for the live preview, filtered to the
  // active style's schema so leftover keys never crash the renderer.
  const activeOptions = useMemo(
    () => filterOptionsForStyle(style, optionsByStyle[style] ?? {}),
    [style, optionsByStyle],
  );

  const fields = useMemo(() => getStyleFields(style), [style]);
  const commonFields = useMemo(
    () => fields.filter((f) => COMMON_KEYS.has(f.key)),
    [fields],
  );
  const styleFields = useMemo(
    () => fields.filter((f) => !COMMON_KEYS.has(f.key)),
    [fields],
  );

  const setOption = (key: string, value: unknown) => {
    setOptionsByStyle((prev) => {
      const cur = { ...(prev[style] ?? {}) };
      if (value === undefined) {
        delete cur[key];
      } else {
        cur[key] = value;
        // When the user explicitly picks an enum value (e.g.
        // ``accessories: ["round"]``, ``facialHair: ["beardLight"]``),
        // auto-bump the matching ``*Probability`` companion to 100.
        // DiceBear ships those probabilities at 10–50%, which means
        // a fresh "I want round glasses" pick only renders glasses
        // on a fraction of seeds — confusing in an editor where the
        // user's expectation is "I picked it, show it". We only
        // bump if the user hasn't explicitly set the probability
        // themselves; once they touch the slider, their value is
        // sticky.
        const probKey = `${key}Probability`;
        const fieldList = getStyleFields(style);
        const hasProbField = fieldList.some((f) => f.key === probKey);
        if (hasProbField && cur[probKey] === undefined) {
          cur[probKey] = 100;
        }
      }
      return { ...prev, [style]: cur };
    });
  };

  const handleLucky = () => setSeed(randomSeed());

  const handleResetToBuiltin = async () => {
    if (!initial || initial.source !== "builtin") return;
    setSaving(true);
    setErr(null);
    try {
      await adminResetCharacterToBuiltin(initial.id);
      onSaved();
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleResetStyleOptions = () => {
    setOptionsByStyle((prev) => ({ ...prev, [style]: {} }));
  };

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
        phonetic_name: phoneticName,
        description,
        behavior_prompt: behaviorPrompt,
        avatar_style: style,
        avatar_seed: seed,
        avatar_config: activeOptions,
      };
      if (initial) await adminPatchCharacter(initial.id, body);
      else await adminCreateCharacter(body);
      onSaved();
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-[1280px] h-[92vh] flex flex-col rounded-2xl border border-border/40 bg-background shadow-m4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/20 px-6 py-4 shrink-0">
          <div className="flex items-center gap-3">
            <Sparkles className="text-primary w-5 h-5" />
            <div>
              <h3 className="text-lg font-bold">
                {initial ? `Edit: ${initial.name}` : "Character Playground"}
              </h3>
              <p className="text-[11px] text-muted-foreground">
                Visual identity, voice (Phase 2), and personality.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>

        {err && (
          <div className="px-6 pt-4 shrink-0">
            <div className="rounded-lg border border-red-400/30 bg-red-400/5 p-3 text-[11px] text-red-300">
              {err}
            </div>
          </div>
        )}

        {/* Three-pane body */}
        <div className="flex-1 grid grid-cols-[360px_minmax(0,1fr)_360px] gap-0 overflow-hidden">
          {/* LEFT — visual */}
          <div className="border-r border-border/20 p-5 space-y-4 overflow-y-auto">
            {/* Light neutral backdrop so dark-line styles like
                 toon-head (which ships with no default background)
                 are visible against the dark UI. Users who set an
                 explicit backgroundColor see it inside the SVG; the
                 backdrop only shows through transparent areas. */}
            <div
              className="aspect-square w-full rounded-2xl border border-border/40 flex items-center justify-center shadow-inner overflow-hidden"
              style={{
                background:
                  "repeating-conic-gradient(rgba(255,255,255,0.04) 0% 25%, rgba(255,255,255,0.08) 0% 50%) 50% / 24px 24px",
              }}
            >
              <RiggedDicebearAvatar
                style={style}
                seed={seed}
                baseOptions={activeOptions}
                size={320}
                tiltState={tiltState}
                manualTiltDeg={manualTilt ?? undefined}
                className="drop-shadow-lg"
              />
            </div>

            {/* Animation controls — drives the live preview's
                 useHeadTilt hook so admins can audition the built-in
                 tilt states (idle / dozing / sleeping / thinking /
                 listening / speaking / sick) and manually scrub the
                 head angle with a slider. */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Animation
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setTiltState("still");
                    setManualTilt(null);
                  }}
                  className="text-[9px] font-bold px-2 py-0.5 rounded border border-border/40 text-muted-foreground hover:text-foreground hover:bg-card/40"
                  title="Stop the running animation and ease the head back to upright"
                >
                  ■ Stop
                </button>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    "idle",
                    "dozing",
                    "sleeping",
                    "thinking",
                    "listening",
                    "speaking",
                    "sick",
                  ] as HeadTiltState[]
                ).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setManualTilt(null);
                      setTiltState(s);
                    }}
                    className={`text-[9px] font-bold py-1 rounded border transition-all ${
                      tiltState === s && manualTilt === null
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border/30 bg-card/30 hover:border-border/60 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="space-y-1 pt-1">
                <div className="flex items-center justify-between text-[9px] font-mono text-muted-foreground">
                  <span>Manual tilt</span>
                  <span>
                    {manualTilt === null ? "—" : `${manualTilt.toFixed(0)}°`}
                  </span>
                </div>
                <input
                  type="range"
                  min={-30}
                  max={30}
                  step={1}
                  value={manualTilt ?? 0}
                  onChange={(e) => setManualTilt(Number(e.target.value))}
                  className="w-full accent-primary"
                />
                <div className="text-[9px] text-muted-foreground/70 leading-tight">
                  Dragging the slider overrides the active state. Click a
                  state button to release.
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Style
              </label>
              <div className="grid grid-cols-3 gap-2">
                {STYLES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStyle(s)}
                    className={`flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-all ${
                      style === s
                        ? "border-primary bg-primary/10 shadow-m1"
                        : "border-border/30 bg-card/30 hover:border-border/60"
                    }`}
                  >
                    <div
                      className="w-12 h-12 rounded overflow-hidden"
                      style={{
                        background:
                          "repeating-conic-gradient(rgba(255,255,255,0.05) 0% 25%, rgba(255,255,255,0.10) 0% 50%) 50% / 8px 8px",
                      }}
                    >
                      <Avatar
                        style={s}
                        seed={seed}
                        size={48}
                        options={filterOptionsForStyle(s, optionsByStyle[s] ?? {})}
                      />
                    </div>
                    <span className="text-[9px] font-mono">{s}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Seed
              </label>
              <div className="flex gap-2">
                <input
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                  className="flex-1 min-w-0 bg-card/50 border border-border/40 rounded-md px-2 py-2 text-xs font-mono"
                />
                <button
                  type="button"
                  onClick={() => setSeed(randomSeed())}
                  title="New seed"
                  className="px-2 rounded-md border border-border/40 bg-card/50 hover:bg-card"
                >
                  <RefreshCw size={12} />
                </button>
                <button
                  type="button"
                  onClick={handleLucky}
                  className="flex items-center gap-1 px-2 rounded-md bg-primary text-white text-[10px] font-bold hover:bg-primary/90"
                >
                  <Sparkles size={10} /> Lucky
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={handleResetStyleOptions}
              className="w-full text-[10px] font-bold text-muted-foreground hover:text-foreground border border-border/30 rounded-md py-2 hover:bg-card/40"
            >
              Reset {style} options
            </button>
          </div>

          {/* MIDDLE — prompt */}
          <div className="p-5 space-y-4 overflow-y-auto border-r border-border/20">
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
                Phonetic Name <span className="text-muted-foreground/60">(optional)</span>
              </label>
              <input
                value={phoneticName}
                onChange={(e) => setPhoneticName(e.target.value)}
                placeholder="For TTS pronunciation"
                className="w-full bg-card/50 border border-border/40 rounded-md px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Description (tagline)
              </label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Mischievous helper"
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
                rows={18}
                placeholder="Speak like a helpful robot with a slight glitch."
                className="w-full bg-card/50 border border-border/40 rounded-md px-3 py-2 text-sm font-medium resize-none"
              />
            </div>
          </div>

          {/* RIGHT — schema-driven options */}
          <div className="overflow-y-auto">
            <div className="sticky top-0 bg-background/95 backdrop-blur px-4 py-3 border-b border-border/20">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Options · {style}
              </div>
            </div>
            <div className="p-3 space-y-4">
              <div>
                <div className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/70 px-2 mb-1">
                  Common
                </div>
                <div className="space-y-0.5">
                  {commonFields.map((f) => (
                    <SchemaField
                      key={f.key}
                      field={f}
                      value={(optionsByStyle[style] ?? {})[f.key]}
                      onChange={setOption}
                    />
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/70 px-2 mb-1">
                  {style}
                </div>
                <div className="space-y-0.5">
                  {styleFields.map((f) => (
                    <SchemaField
                      key={f.key}
                      field={f}
                      value={(optionsByStyle[style] ?? {})[f.key]}
                      onChange={setOption}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border/20 shrink-0">
          {initial?.source === "builtin" && (
            <button
              type="button"
              onClick={handleResetToBuiltin}
              disabled={saving}
              className="mr-auto px-4 py-2 rounded-md border border-amber-400/40 text-amber-300 text-xs font-bold hover:bg-amber-400/10 disabled:opacity-50"
              title="Restore this builtin to its shipped defaults"
            >
              Reset to Default
            </button>
          )}
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
            className="flex items-center gap-2 px-5 py-2 rounded-md bg-primary text-white text-xs font-bold hover:bg-primary/90 disabled:opacity-50"
          >
            <Save size={12} />
            {saving ? "Saving…" : initial ? "Save Changes" : "Create Character"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CharacterPlayground;
