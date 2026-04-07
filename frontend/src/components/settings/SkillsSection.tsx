/**
 * SkillsSection — per-skill global+user configuration UI.
 *
 * Renders one card per registered skill. Each card has up to two
 * column groups, driven entirely by the skill manifest's
 * config_schema:
 *
 *   * Global tier (admin-only inputs; read-only "Configured" badge
 *     for non-admin users so they can still see whether a server
 *     prerequisite like an API key has been provisioned).
 *   * User tier  (every authenticated user can edit their own row).
 *
 * Secret-typed fields never show the stored value — the API masks
 * them as { _set: bool }. We render an input that's blank by default
 * with a "Configured ✓" hint when set; submitting a new value
 * replaces it, submitting empty leaves it unchanged.
 */
import React, { useEffect, useState } from "react";
import {
  Wrench,
  Save,
  Check,
  ShieldAlert,
  User as UserIcon,
  AlertTriangle,
  CheckCircle2,
  Power,
  Info,
} from "lucide-react";

/**
 * Tiny pill toggle. Avoids adding a shadcn switch primitive — this
 * is the only place we need on/off control in settings right now.
 */
const PillToggle: React.FC<{
  enabled: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}> = ({ enabled, disabled, onChange, label }) => (
  <button
    type="button"
    onClick={() => !disabled && onChange(!enabled)}
    disabled={disabled}
    aria-pressed={enabled}
    aria-label={label}
    className={`inline-flex items-center h-6 w-11 rounded-full border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      enabled
        ? "bg-primary/30 border-primary/40"
        : "bg-muted/20 border-border/40"
    }`}
  >
    <span
      className={`inline-block h-4 w-4 rounded-full bg-foreground transition-transform ${
        enabled ? "translate-x-6" : "translate-x-1"
      }`}
    />
  </button>
);
import {
  listSkills,
  setSkillGlobal,
  setSkillUser,
  setSkillToggleUser,
  type SkillSummary,
  type SkillConfigField,
} from "../../lib/api";
import { useAuth } from "../../auth/useAuth";

type Tier = "global" | "user";

function isSecretSet(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "_set" in raw &&
    Boolean((raw as { _set: boolean })._set)
  );
}

function readableValue(field: SkillConfigField, raw: unknown): string {
  if (field.type === "secret") return ""; // never echo secrets
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "boolean") return raw ? "true" : "false";
  return String(raw);
}

interface FieldRowProps {
  field: SkillConfigField;
  raw: unknown;
  disabled: boolean;
  missing: boolean;
  onSave: (value: unknown) => Promise<void>;
}

const FieldRow: React.FC<FieldRowProps> = ({
  field,
  raw,
  disabled,
  missing,
  onSave,
}) => {
  const [value, setValue] = useState<string>(() => readableValue(field, raw));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setValue(readableValue(field, raw));
  }, [raw, field]);

  const secretConfigured = field.type === "secret" && isSecretSet(raw);

  const handleSave = async () => {
    if (disabled) return;
    // For secrets: empty input means "leave alone" — don't clobber.
    if (field.type === "secret" && value === "") return;
    setBusy(true);
    try {
      let coerced: unknown = value;
      if (field.type === "boolean") coerced = value === "true";
      else if (field.type === "integer") coerced = parseInt(value, 10);
      else if (field.type === "number") coerced = parseFloat(value);
      await onSave(coerced);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      if (field.type === "secret") setValue("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
          {field.label || field.key}
          {field.required && <span className="text-primary ml-1">*</span>}
        </label>
        {missing ? (
          <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20">
            Required
          </span>
        ) : secretConfigured ? (
          <span className="text-[10px] font-bold text-green-400 bg-green-500/10 px-2 py-0.5 rounded-md border border-green-500/20">
            Configured
          </span>
        ) : null}
      </div>
      {field.description && (
        <p className="text-[11px] text-muted-foreground/80">{field.description}</p>
      )}
      <div className="flex gap-2">
        {field.type === "boolean" ? (
          <select
            value={value || "false"}
            onChange={(e) => setValue(e.target.value)}
            disabled={disabled}
            className="flex-1 bg-card/50 border border-border/50 rounded-lg p-2 text-sm font-medium focus:outline-none focus:border-primary/50 disabled:opacity-50"
          >
            <option value="false">false</option>
            <option value="true">true</option>
          </select>
        ) : (
          <input
            type={field.type === "secret" ? "password" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={disabled}
            placeholder={
              field.type === "secret" && secretConfigured
                ? "•••••••• (enter to replace)"
                : ""
            }
            className="flex-1 bg-card/50 border border-border/50 rounded-lg p-2 text-sm font-medium focus:outline-none focus:border-primary/50 disabled:opacity-50"
          />
        )}
        <button
          onClick={handleSave}
          disabled={disabled || busy}
          className={`px-3 rounded-lg text-xs font-bold transition-all ${
            saved
              ? "bg-green-500/20 text-green-400 border border-green-500/30"
              : "bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20"
          } disabled:opacity-40`}
        >
          {saved ? <Check size={14} /> : <Save size={14} />}
        </button>
      </div>
    </div>
  );
};

/**
 * Hover/click info button. Shows what the skill does, the intents
 * the decomposer can route to it, and a few example questions
 * pulled from the manifest. Uses native <details> for the click
 * affordance so we don't add a new primitive.
 */
const SkillInfoPopover: React.FC<{ skill: SkillSummary }> = ({ skill }) => {
  if (
    !skill.description &&
    !(skill.examples || []).length &&
    !(skill.intents || []).length
  ) {
    return null;
  }
  return (
    <div className="relative group/info inline-block">
      <button
        type="button"
        className="inline-flex items-center justify-center w-5 h-5 rounded-full text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
        aria-label={`About ${skill.name}`}
      >
        <Info size={13} />
      </button>
      <div className="hidden group-hover/info:block absolute left-0 top-6 z-20 w-80 p-4 rounded-xl bg-card border border-border/40 shadow-m4 text-xs space-y-3">
        {skill.description && (
          <p className="text-foreground/90 leading-relaxed">
            {skill.description}
          </p>
        )}
        {(skill.examples || []).length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
              Try asking
            </div>
            <ul className="space-y-0.5">
              {skill.examples.map((ex) => (
                <li key={ex} className="text-foreground/80 italic">
                  &ldquo;{ex}&rdquo;
                </li>
              ))}
            </ul>
          </div>
        )}
        {(skill.intents || []).length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
              Intents
            </div>
            <div className="flex flex-wrap gap-1">
              {skill.intents.map((i) => (
                <code
                  key={i}
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground"
                >
                  {i}
                </code>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};


interface SkillCardProps {
  skill: SkillSummary;
  isAdmin: boolean;
  onChanged: () => void;
}

const SkillCard: React.FC<SkillCardProps> = ({ skill, isAdmin, onChanged }) => {
  const schema = skill.config_schema || { global: [], user: [] };
  const hasGlobal = (schema.global || []).length > 0;
  const hasUser = (schema.user || []).length > 0;

  const renderTier = (tier: Tier, fields: SkillConfigField[]) => {
    const values = tier === "global" ? skill.global : skill.user;
    const disabled = tier === "global" && !isAdmin;
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">
          {tier === "global" ? <ShieldAlert size={12} /> : <UserIcon size={12} />}
          {tier === "global" ? "Global (admin)" : "Personal"}
          {disabled && (
            <span className="text-[10px] font-medium text-muted-foreground/60 normal-case tracking-normal">
              read-only
            </span>
          )}
        </div>
        {fields.map((f) => (
          <FieldRow
            key={f.key}
            field={f}
            raw={values?.[f.key]}
            disabled={disabled}
            missing={
              !!f.required && skill.missing_required.includes(f.key)
            }
            onSave={async (v) => {
              if (tier === "global") {
                await setSkillGlobal(skill.skill_id, f.key, v);
              } else {
                await setSkillUser(skill.skill_id, f.key, v);
              }
              onChanged();
            }}
          />
        ))}
      </div>
    );
  };

  // The orchestrator skips a skill at chat time when any of three
  // gates is closed: admin manual toggle, user manual toggle, or
  // missing required config. The status badge distinguishes the
  // *intent* behind the off-state — a skill that's "Off" was turned
  // off on purpose, while one that's "Setup Required" is waiting
  // on configuration the operator forgot to provide.
  const status: {
    label: string;
    tone: "ready" | "setup" | "off";
    Icon: typeof CheckCircle2;
  } = (() => {
    if (skill.enabled) {
      return { label: "Ready", tone: "ready", Icon: CheckCircle2 };
    }
    if (skill.disabled_reason === "config") {
      return { label: "Setup Required", tone: "setup", Icon: AlertTriangle };
    }
    return { label: "Off", tone: "off", Icon: Power };
  })();
  const reasonText = (() => {
    switch (skill.disabled_reason) {
      case "global_toggle":
        return "Turned off by admin.";
      case "user_toggle":
        return "Turned off in your personal settings.";
      case "config":
        return "This skill is waiting on configuration before it can run.";
      default:
        return null;
    }
  })();
  const cardTone =
    status.tone === "ready"
      ? "bg-card/40 border-border/30"
      : status.tone === "setup"
        ? "bg-amber-500/5 border-amber-500/30"
        : "bg-muted/10 border-border/40";
  const badgeTone =
    status.tone === "ready"
      ? "text-green-400 bg-green-500/10 border-green-500/20"
      : status.tone === "setup"
        ? "text-amber-400 bg-amber-500/10 border-amber-500/30"
        : "text-muted-foreground bg-muted/20 border-border/40";
  const bannerTone =
    status.tone === "setup"
      ? "bg-amber-500/10 border-amber-500/20 text-amber-200"
      : "bg-muted/10 border-border/40 text-muted-foreground";

  return (
    <div className={`p-5 rounded-2xl border space-y-5 ${cardTone}`}>
      <div className="flex items-baseline justify-between border-b border-border/10 pb-3 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-base font-bold tracking-tight truncate">
            {skill.name}
          </h3>
          <SkillInfoPopover skill={skill} />
          <code className="text-[10px] text-muted-foreground/70 font-mono">
            {skill.skill_id}
          </code>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-md border ${badgeTone}`}
          >
            <status.Icon size={12} /> {status.label}
          </span>
          <PillToggle
            enabled={skill.toggle.user}
            label="Turn this skill on or off"
            onChange={async (next) => {
              await setSkillToggleUser(skill.skill_id, next);
              onChanged();
            }}
          />
        </div>
      </div>

      {reasonText && (
        <div
          className={`flex items-start gap-2 p-3 rounded-lg border text-[11px] ${bannerTone}`}
        >
          <status.Icon size={14} className="shrink-0 mt-0.5" />
          <div>
            <strong className="font-bold">{reasonText}</strong>{" "}
            {skill.disabled_reason === "config" &&
              skill.missing_required.length > 0 && (
                <>
                  Missing field
                  {skill.missing_required.length > 1 ? "s" : ""}:{" "}
                  <span className="font-mono">
                    {skill.missing_required.join(", ")}
                  </span>
                </>
              )}
          </div>
        </div>
      )}
      {!hasGlobal && !hasUser && (
        <p className="text-xs text-muted-foreground italic">
          This skill has no user-facing configuration.
        </p>
      )}
      {(hasGlobal || hasUser) && (
        <div className="grid md:grid-cols-2 gap-6">
          {hasGlobal && renderTier("global", schema.global)}
          {hasUser && renderTier("user", schema.user)}
        </div>
      )}
    </div>
  );
};

const SkillsSection: React.FC = () => {
  const { currentUser } = useAuth();
  const isAdmin = currentUser?.role === "admin";
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 border-b border-border/10 pb-4">
        <Wrench className="text-primary w-5 h-5" />
        <h2 className="text-xl font-bold tracking-tight">Skills</h2>
        <span className="text-[10px] font-bold text-muted-foreground bg-muted/10 px-2 py-0.5 rounded-md border border-border/20 ml-2">
          {isAdmin ? "ADMIN" : "USER"}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Configure server-wide credentials (admin) and your personal preferences
        for each skill.
      </p>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : skills.length === 0 ? (
        <p className="text-xs text-muted-foreground">No skills available.</p>
      ) : (
        <div className="space-y-4">
          {skills.map((s) => (
            <SkillCard
              key={s.skill_id}
              skill={s}
              isAdmin={isAdmin}
              onChanged={reload}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default SkillsSection;
