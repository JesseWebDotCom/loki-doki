/**
 * Compact tile shown in the skills grid. Click to open the detail
 * dialog. Status dot mirrors the same three-state model the old big
 * card used: ready / setup-required / off.
 */
import React from "react";
import type { SkillSummary } from "../../../lib/api";
import { iconForSkill } from "./categories";

interface Props {
  skill: SkillSummary;
  onClick: () => void;
}

function statusDotClass(skill: SkillSummary): string {
  if (skill.enabled) return "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]";
  if (skill.disabled_reason === "config") return "bg-amber-400";
  return "bg-muted-foreground/40";
}

const SkillTile: React.FC<Props> = ({ skill, onClick }) => {
  const Icon = iconForSkill(skill.skill_id);
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex flex-col items-start gap-2 p-4 rounded-2xl border border-border/30 bg-card/40 hover:bg-card/70 hover:border-primary/40 transition-all text-left h-full"
    >
      <span
        className={`absolute top-3 right-3 inline-block w-2 h-2 rounded-full ${statusDotClass(skill)}`}
        aria-label={skill.enabled ? "ready" : skill.disabled_reason || "off"}
      />
      <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 text-primary group-hover:bg-primary/20 transition-colors">
        <Icon size={20} />
      </div>
      <h3 className="text-sm font-bold tracking-tight truncate w-full">
        {skill.name}
      </h3>
      {skill.description && (
        <p className="text-[11px] text-muted-foreground line-clamp-2 leading-snug">
          {skill.description}
        </p>
      )}
    </button>
  );
};

export default SkillTile;
