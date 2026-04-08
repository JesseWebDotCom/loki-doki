/**
 * ChatWelcomeView — empty-state landing for a brand-new chat.
 *
 * Replaces the synthetic "LokiDoki Core initialized…" assistant
 * message we used to seed every blank session with. That message
 * cluttered the history (it persisted into the messages array, picked
 * up an avatar slot, and counted as the "latest assistant" for active-
 * key fallback) and offered the user no guidance.
 *
 * Now: a centered, low-density greeting that uses the active
 * character's identity when one is loaded. No history pollution.
 */
import React from "react";
import RiggedDicebearAvatar from "../character/RiggedDicebearAvatar";
import type { CharacterRow } from "../../lib/api";

interface Props {
  activeChar?: CharacterRow | null;
}

const ChatWelcomeView: React.FC<Props> = ({ activeChar }) => {
  const name = activeChar?.name ?? "LokiDoki";
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
      <div className="max-w-xl animate-in fade-in slide-in-from-bottom-4 duration-700">
        {activeChar && (
          <div className="mb-6 flex justify-center">
            <RiggedDicebearAvatar
              style={activeChar.avatar_style}
              seed={activeChar.avatar_seed}
              baseOptions={activeChar.avatar_config as Record<string, unknown>}
              size={140}
              tiltState="listening"
            />
          </div>
        )}
        <h1 className="text-2xl font-bold tracking-tight mb-2">
          Hi, I'm {name}.
        </h1>
        <p className="text-sm text-muted-foreground">
          Ask me anything to get started.
        </p>
      </div>
    </div>
  );
};

export default ChatWelcomeView;
