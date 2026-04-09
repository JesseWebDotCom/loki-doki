/**
 * One editable config field inside the skill detail dialog.
 *
 * Secret-typed fields never echo their stored value — the API masks
 * them as { _set: bool }. We render an input that's blank by default
 * with a "Configured" hint when set; submitting a new value replaces
 * it, submitting empty leaves it unchanged.
 */
import React, { useEffect, useState } from "react";
import { Save, Check } from "lucide-react";
import type { SkillConfigField } from "../../../lib/api";

function isSecretSet(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "_set" in raw &&
    Boolean((raw as { _set: boolean })._set)
  );
}

function readableValue(field: SkillConfigField, raw: unknown): string {
  if (field.type === "secret") return "";
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "boolean") return raw ? "true" : "false";
  return String(raw);
}

interface Props {
  field: SkillConfigField;
  raw: unknown;
  disabled: boolean;
  missing: boolean;
  onSave: (value: unknown) => Promise<void>;
}

const SkillFieldRow: React.FC<Props> = ({
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

export default SkillFieldRow;
