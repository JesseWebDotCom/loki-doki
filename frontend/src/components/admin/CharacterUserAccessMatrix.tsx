import React, { useEffect, useState } from "react";
import { Users, Check, X, RotateCcw } from "lucide-react";
import {
  adminGetUserAccess,
  adminSetUserEnabled,
  type CharacterAccessRow,
} from "../../lib/api";

/**
 * Per-user character access matrix.
 *
 * Lists every catalog character for a chosen user with three
 * controls: Allow (force enable for this user), Deny (force disable),
 * Inherit (clear the override and fall back to global). The
 * effective state is shown as a badge so admins can see when a
 * global disable has overridden their per-user "allow".
 *
 * The user dropdown is fed by the existing /api/v1/admin/users
 * endpoint that the AdminPage already polls — we accept the user
 * list as a prop instead of refetching to keep this component
 * cohesive with the surrounding admin shell.
 */
type AdminUser = { id: number; username: string };

type Props = {
  users: AdminUser[];
  // Reload trigger from the parent — when the catalog changes (a new
  // character is added or one is deleted), the matrix needs to refetch.
  refreshKey?: number;
};

const CharacterUserAccessMatrix: React.FC<Props> = ({ users, refreshKey }) => {
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [matrix, setMatrix] = useState<CharacterAccessRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (users.length > 0 && selectedUserId == null) {
      setSelectedUserId(users[0].id);
    }
  }, [users, selectedUserId]);

  useEffect(() => {
    if (selectedUserId != null) void load(selectedUserId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUserId, refreshKey]);

  const load = async (uid: number) => {
    setLoading(true);
    try {
      const res = await adminGetUserAccess(uid);
      setMatrix(res.matrix);
    } catch {
      setMatrix([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSet = async (
    characterId: number,
    enabled: boolean | null,
  ) => {
    if (selectedUserId == null) return;
    try {
      await adminSetUserEnabled(selectedUserId, characterId, enabled);
      await load(selectedUserId);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 border-b border-border/10 pb-4">
        <Users className="text-primary w-5 h-5" />
        <h2 className="text-xl font-bold tracking-tight">
          Per-User Character Access
        </h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Restrict or force-allow individual characters for specific users.
        Leaving everything on <em>Inherit</em> means the user sees every
        globally-enabled character.
      </p>

      <div className="flex items-center gap-3">
        <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          User
        </label>
        <select
          value={selectedUserId ?? ""}
          onChange={(e) => setSelectedUserId(Number(e.target.value))}
          className="bg-card/50 border border-border/40 rounded-md px-3 py-2 text-sm font-medium"
        >
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : matrix.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">
          No characters in catalog.
        </div>
      ) : (
        <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="text-left text-[10px] font-bold uppercase tracking-widest text-muted-foreground border-b border-border/20">
                <th className="px-4 py-3">Character</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Override</th>
                <th className="px-4 py-3">Effective</th>
                <th className="px-4 py-3 text-right">Set</th>
              </tr>
            </thead>
            <tbody>
              {matrix.map((row) => (
                <tr
                  key={row.character_id}
                  className="border-b border-border/10 last:border-0 text-sm"
                >
                  <td className="px-4 py-3 font-bold">{row.name}</td>
                  <td className="px-4 py-3">
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/40">
                      {row.source}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {row.user_override === null ? (
                      <span className="text-[10px] text-muted-foreground italic">
                        inherit
                      </span>
                    ) : row.user_override ? (
                      <span className="text-[10px] font-bold text-green-400">
                        allow
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold text-red-400">
                        deny
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {row.effective ? (
                      <span className="text-[10px] font-bold text-green-400 flex items-center gap-1">
                        <Check size={10} /> visible
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold text-muted-foreground flex items-center gap-1">
                        <X size={10} /> hidden
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        title="Allow"
                        onClick={() => void handleSet(row.character_id, true)}
                        className="p-1.5 rounded border border-green-400/30 bg-green-400/5 text-green-400 hover:bg-green-400/15"
                      >
                        <Check size={11} />
                      </button>
                      <button
                        type="button"
                        title="Deny"
                        onClick={() => void handleSet(row.character_id, false)}
                        className="p-1.5 rounded border border-red-400/30 bg-red-400/5 text-red-400 hover:bg-red-400/15"
                      >
                        <X size={11} />
                      </button>
                      <button
                        type="button"
                        title="Inherit from global"
                        onClick={() => void handleSet(row.character_id, null)}
                        className="p-1.5 rounded border border-border/40 bg-card/50 text-muted-foreground hover:text-foreground"
                      >
                        <RotateCcw size={11} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default CharacterUserAccessMatrix;
