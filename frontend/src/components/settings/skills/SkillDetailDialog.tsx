/**
 * Detail dialog opened from a SkillTile. Hosts the same global+user
 * config columns the old inline card had, plus an admin-only "Test"
 * panel that forces a prompt through this specific skill via
 * POST /skills/{id}/test (bypassing decomposer routing).
 */
import React, { useState } from "react";
import {
  ShieldAlert,
  User as UserIcon,
  AlertTriangle,
  CheckCircle2,
  Power,
  Play,
  Loader2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../ui/dialog";
import {
  setSkillGlobal,
  setSkillUser,
  setSkillToggleUser,
  testSkill,
  type SkillSummary,
  type SkillConfigField,
  type SkillTestResult,
} from "../../../lib/api";
import SkillFieldRow from "./SkillFieldRow";
import { iconForSkill } from "./categories";

type Tier = "global" | "user";

interface Props {
  skill: SkillSummary;
  isAdmin: boolean;
  /** Show the test panel. Distinct from isAdmin: an admin viewing
   *  their personal Settings shouldn't see the test affordance, only
   *  the dedicated admin-page mount enables it. */
  enableTesting: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}

const PillToggle: React.FC<{
  enabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
}> = ({ enabled, onChange, label }) => (
  <button
    type="button"
    onClick={() => onChange(!enabled)}
    aria-pressed={enabled}
    aria-label={label}
    className={`inline-flex items-center h-6 w-11 rounded-full border transition-colors ${
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

const SkillDetailDialog: React.FC<Props> = ({
  skill,
  isAdmin,
  enableTesting,
  open,
  onOpenChange,
  onChanged,
}) => {
  const Icon = iconForSkill(skill.skill_id);
  const schema = skill.config_schema || { global: [], user: [] };
  const hasGlobal = (schema.global || []).length > 0;
  const hasUser = (schema.user || []).length > 0;

  const [testPrompt, setTestPrompt] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<SkillTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const runTest = async () => {
    if (!testPrompt.trim()) return;
    setTestBusy(true);
    setTestError(null);
    setTestResult(null);
    try {
      const r = await testSkill(skill.skill_id, testPrompt.trim());
      setTestResult(r);
    } catch (e) {
      setTestError((e as Error).message || "test failed");
    } finally {
      setTestBusy(false);
    }
  };

  const status = (() => {
    if (skill.enabled)
      return { label: "Ready", tone: "ready", Icon: CheckCircle2 };
    if (skill.disabled_reason === "config")
      return { label: "Setup Required", tone: "setup", Icon: AlertTriangle };
    return { label: "Off", tone: "off", Icon: Power };
  })();
  const badgeTone =
    status.tone === "ready"
      ? "text-green-400 bg-green-500/10 border-green-500/20"
      : status.tone === "setup"
        ? "text-amber-400 bg-amber-500/10 border-amber-500/30"
        : "text-muted-foreground bg-muted/20 border-border/40";

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
          <SkillFieldRow
            key={f.key}
            field={f}
            raw={values?.[f.key]}
            disabled={disabled}
            missing={!!f.required && skill.missing_required.includes(f.key)}
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 text-primary shrink-0">
              <Icon size={24} />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="flex items-center gap-2 flex-wrap">
                {skill.name}
                <code className="text-[10px] text-muted-foreground/70 font-mono font-normal">
                  {skill.skill_id}
                </code>
                <span
                  className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md border ${badgeTone}`}
                >
                  <status.Icon size={11} /> {status.label}
                </span>
              </DialogTitle>
              {skill.description && (
                <DialogDescription className="mt-1">
                  {skill.description}
                </DialogDescription>
              )}
            </div>
            <PillToggle
              enabled={skill.toggle.user}
              label="Turn this skill on or off"
              onChange={async (next) => {
                await setSkillToggleUser(skill.skill_id, next);
                onChanged();
              }}
            />
          </div>
        </DialogHeader>

        {!hasGlobal && !hasUser && (
          <p className="text-xs text-muted-foreground italic">
            This skill has no user-facing configuration.
          </p>
        )}
        {(hasGlobal || hasUser) && (
          <div className="grid md:grid-cols-2 gap-6 pt-2">
            {hasGlobal && renderTier("global", schema.global)}
            {hasUser && renderTier("user", schema.user)}
          </div>
        )}

        {(skill.examples || []).length > 0 && (
          <div className="pt-2 space-y-1">
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
              Try asking
            </div>
            <ul className="space-y-0.5 text-xs">
              {skill.examples.map((ex) => (
                <li key={ex} className="text-foreground/80 italic">
                  &ldquo;{ex}&rdquo;
                </li>
              ))}
            </ul>
          </div>
        )}

        {enableTesting && (
          <div className="pt-4 mt-2 border-t border-border/20 space-y-2">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">
              <Play size={12} /> Test
              <span className="text-[10px] font-medium text-muted-foreground/60 normal-case tracking-normal">
                bypasses decomposer — runs this skill directly
              </span>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={testPrompt}
                onChange={(e) => setTestPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !testBusy) runTest();
                }}
                placeholder="Enter a prompt to force through this skill…"
                className="flex-1 bg-card/50 border border-border/50 rounded-lg p-2 text-sm focus:outline-none focus:border-primary/50"
              />
              <button
                onClick={runTest}
                disabled={testBusy || !testPrompt.trim()}
                className="px-4 rounded-lg text-xs font-bold bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 disabled:opacity-40 inline-flex items-center gap-1"
              >
                {testBusy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                Run
              </button>
            </div>
            {testError && (
              <p className="text-xs text-red-400">{testError}</p>
            )}
            {testResult && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-[11px]">
                  <span
                    className={`px-2 py-0.5 rounded border ${
                      testResult.success
                        ? "text-green-400 bg-green-500/10 border-green-500/20"
                        : "text-red-400 bg-red-500/10 border-red-500/20"
                    }`}
                  >
                    {testResult.success ? "success" : "failed"}
                  </span>
                  {testResult.mechanism_used && (
                    <span className="text-muted-foreground font-mono">
                      {testResult.mechanism_used}
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    {Math.round(testResult.latency_ms)}ms
                  </span>
                </div>
                <pre className="text-[11px] bg-muted/20 border border-border/30 rounded-lg p-3 overflow-auto max-h-64 font-mono">
                  {JSON.stringify(testResult.data, null, 2)}
                </pre>
                {testResult.mechanism_log.length > 1 && (
                  <details className="text-[11px]">
                    <summary className="cursor-pointer text-muted-foreground">
                      Mechanism log ({testResult.mechanism_log.length})
                    </summary>
                    <pre className="mt-1 bg-muted/10 border border-border/20 rounded-lg p-2 overflow-auto font-mono">
                      {JSON.stringify(testResult.mechanism_log, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default SkillDetailDialog;
