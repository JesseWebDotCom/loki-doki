import React, { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SchemaField as Field } from "./styleSchemas";

/**
 * Generic renderer for one DiceBear schema field.
 *
 * Maps the flattened ``FieldKind`` taxonomy to a control:
 *   - ``boolean``       → toggle
 *   - ``integer``       → range slider with numeric readout
 *   - ``color-array``   → wrapped color swatches (single-select for v1)
 *   - ``enum-array``    → chip multiselect (collapsed by default to
 *                        keep avataaars' 30+ tops/clothes from eating
 *                        the panel)
 *   - ``string-array``  → readonly chip list (rare; placeholder)
 *
 * Why single-select for color-array even though the schema allows
 * multiple: when DiceBear gets multiple color values it picks one
 * via the seed PRNG. For an editor preview that's confusing because
 * the same seed always lands on the same color regardless of which
 * extras are passed. Forcing a single selection makes the swatch
 * picker actually feel like "set this color" instead of "expand the
 * roulette". Power users can still pass arrays via the API.
 */
type Props = {
  field: Field;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
};

const humanize = (key: string) =>
  key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();

const Swatch: React.FC<{
  color: string;
  selected: boolean;
  onClick: () => void;
}> = ({ color, selected, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    title={color}
    className={`w-6 h-6 rounded-md border-2 transition-all shrink-0 ${
      selected ? "border-primary scale-110" : "border-border/30"
    }`}
    style={{
      background:
        color === "transparent"
          ? "repeating-conic-gradient(#444 0 25%, #222 0 50%) 50% / 6px 6px"
          : `#${color}`,
    }}
  />
);

const SchemaField: React.FC<Props> = ({ field, value, onChange }) => {
  const [expanded, setExpanded] = useState(false);
  const label = humanize(field.key);

  if (field.kind === "boolean") {
    return (
      <label className="flex items-center justify-between gap-3 p-2 rounded-md hover:bg-card/40 cursor-pointer">
        <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
          {label}
        </span>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(field.key, e.target.checked)}
          className="w-4 h-4 accent-primary"
        />
      </label>
    );
  }

  if (field.kind === "integer") {
    const min = field.min ?? 0;
    const max = field.max ?? 100;
    const num = typeof value === "number" ? value : Number(field.default ?? min);
    return (
      <div className="space-y-1.5 p-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
            {label}
          </span>
          <span className="text-[11px] font-mono text-foreground">{num}</span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          value={num}
          onChange={(e) => onChange(field.key, Number(e.target.value))}
          className="w-full accent-primary"
        />
      </div>
    );
  }

  if (field.kind === "color-array") {
    const palette = (field.default as string[] | undefined) ?? [];
    const current = Array.isArray(value) ? (value as string[])[0] : undefined;
    return (
      <div className="space-y-1.5 p-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
            {label}
          </span>
          {current && (
            <button
              type="button"
              onClick={() => onChange(field.key, undefined)}
              className="text-[9px] text-muted-foreground hover:text-foreground"
            >
              clear
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Swatch
            color="transparent"
            selected={!current}
            onClick={() => onChange(field.key, undefined)}
          />
          {palette.map((c) => (
            <Swatch
              key={c}
              color={c}
              selected={current === c}
              onClick={() => onChange(field.key, [c])}
            />
          ))}
        </div>
      </div>
    );
  }

  if (field.kind === "enum-array") {
    // Single-select. DiceBear's option model accepts arrays-as-pools
    // (the seed PRNG picks one), but in an editor "pick eyes: happy"
    // means happy eyes — not "add happy to a roulette of options".
    // We store as a 1-element array so the on-disk shape stays
    // schema-compliant.
    const opts = field.enumValues ?? [];
    const current = Array.isArray(value) ? (value as string[])[0] : undefined;
    const pick = (opt: string | undefined) => {
      onChange(field.key, opt === undefined ? undefined : [opt]);
    };
    return (
      <div className="p-2 space-y-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center justify-between text-[11px] font-bold text-muted-foreground uppercase tracking-wider hover:text-foreground"
        >
          <span className="flex items-center gap-1">
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            {label}
          </span>
          <span className="font-mono text-foreground/70">
            {current ? current : `${opts.length} options`}
          </span>
        </button>
        {expanded && (
          <div className="flex flex-wrap gap-1 pt-1">
            <button
              type="button"
              onClick={() => pick(undefined)}
              className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-all ${
                !current
                  ? "bg-primary/20 border-primary/50 text-primary"
                  : "bg-card/40 border-border/30 text-muted-foreground hover:text-foreground"
              }`}
            >
              random
            </button>
            {opts.map((opt) => {
              const isSel = current === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => pick(opt)}
                  className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-all ${
                    isSel
                      ? "bg-primary/20 border-primary/50 text-primary"
                      : "bg-card/40 border-border/30 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return null;
};

export default SchemaField;
