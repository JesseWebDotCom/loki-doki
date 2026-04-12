/**
 * CharacterFrame — interactive wrapper around RiggedDicebearAvatar.
 *
 * Adds two interactions on top of the static avatar:
 *   1. Click → fires `onShock`, which the parent uses to flip the
 *      character into the transient `shocked` HeadTiltState.
 *   2. Hover → reveals a small toolbar (mini / docked / fullscreen)
 *      docked under the avatar. The toolbar buttons match the visual
 *      weight of the per-message TTS controls in MessageItem.
 *
 * Used for both the small per-message avatars (mini mode) and the
 * large right-column avatar (docked mode), so layout/mode-switching
 * lives in one place.
 */
import React, { useState } from "react";
import { Minimize2, Columns2, Maximize2 } from "lucide-react";
import RiggedDicebearAvatar from "./RiggedDicebearAvatar";
import type { HeadTiltState } from "./useHeadTilt";
import type { CharacterRow } from "../../lib/api";
import type { CharacterMode } from "../../utils/characterMode";

export type { CharacterMode };

interface Props {
  character: CharacterRow;
  size: number;
  state: HeadTiltState;
  mode: CharacterMode;
  onModeChange: (m: CharacterMode) => void;
  onShock: () => void;
  className?: string;
}

const CharacterFrame: React.FC<Props> = ({
  character,
  size,
  state,
  mode,
  onModeChange,
  onShock,
  className,
}) => {
  const [hover, setHover] = useState(false);
  return (
    <div
      className={`relative inline-flex items-center justify-center ${className ?? ""}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        onClick={onShock}
        className="block bg-transparent border-0 p-0 cursor-pointer focus:outline-none"
        aria-label={`${character.name} avatar`}
      >
        <RiggedDicebearAvatar
          style={character.avatar_style}
          seed={character.avatar_seed}
          baseOptions={character.avatar_config as Record<string, unknown>}
          size={size}
          tiltState={state}
        />
      </button>
      {hover && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full pt-2 z-30">
          <div className="flex items-center gap-1 px-2 py-1 rounded-xl bg-card/90 backdrop-blur border border-border/40 shadow-m2">
            <ToolbarBtn
              icon={<Minimize2 size={13} />}
              active={mode === "mini"}
              title="Mini"
              onClick={() => onModeChange("mini")}
            />
            <ToolbarBtn
              icon={<Columns2 size={13} />}
              active={mode === "docked"}
              title="Docked"
              onClick={() => onModeChange("docked")}
            />
            <ToolbarBtn
              icon={<Maximize2 size={13} />}
              active={mode === "fullscreen"}
              title="Fullscreen"
              onClick={() => onModeChange("fullscreen")}
            />
          </div>
        </div>
      )}
    </div>
  );
};

const ToolbarBtn: React.FC<{
  icon: React.ReactNode;
  active: boolean;
  title: string;
  onClick: () => void;
}> = ({ icon, active, title, onClick }) => (
  <button
    type="button"
    title={title}
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
    className={`inline-flex items-center justify-center w-6 h-6 rounded-md transition cursor-pointer ${
      active
        ? "bg-primary/15 text-primary"
        : "text-muted-foreground hover:text-primary hover:bg-primary/10"
    }`}
  >
    {icon}
  </button>
);

export default CharacterFrame;
