import React, { useEffect, useState } from "react";
import { User, Plus, Pencil, Trash2, Power, PowerOff } from "lucide-react";
import {
  adminListCatalog,
  adminDeleteCharacter,
  adminSetGlobalEnabled,
  type AdminCharacterRow,
} from "../../lib/api";
import ConfirmDialog from "../ui/ConfirmDialog";
import CharacterEditDialog from "./CharacterEditDialog";
import CharacterUserAccessMatrix from "./CharacterUserAccessMatrix";

/**
 * Top-level admin section for the character system.
 *
 * Two responsibilities, stacked:
 *   1. Catalog management — list every character, create new ones,
 *      edit (copy-on-write for builtins), delete (blocked for
 *      builtins), and toggle global enabled state.
 *   2. Per-user access matrix — restrict or force-allow individual
 *      characters for specific users (delegated to a child component
 *      so this file stays under the 250-line cap).
 *
 * Both children share a `refreshKey` so a catalog edit invalidates
 * the access matrix cache without prop drilling.
 */
type AdminUser = { id: number; username: string };

type Props = {
  users: AdminUser[];
};

const CharactersAdminSection: React.FC<Props> = ({ users }) => {
  const [catalog, setCatalog] = useState<AdminCharacterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AdminCharacterRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminCharacterRow | null>(
    null,
  );
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    void load();
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const res = await adminListCatalog();
      setCatalog(res.characters);
    } catch {
      setCatalog([]);
    } finally {
      setLoading(false);
    }
  };

  const bumpRefresh = () => setRefreshKey((k) => k + 1);

  const handleSaved = async () => {
    await load();
    bumpRefresh();
  };

  const handleToggleGlobal = async (row: AdminCharacterRow) => {
    try {
      await adminSetGlobalEnabled(row.id, !row.global_enabled);
      await load();
      bumpRefresh();
    } catch {
      /* ignore */
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await adminDeleteCharacter(deleteTarget.id);
      setDeleteTarget(null);
      await load();
      bumpRefresh();
    } catch {
      setDeleteTarget(null);
    }
  };

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-border/10 pb-4">
          <User className="text-primary w-5 h-5" />
          <h2 className="text-xl font-bold tracking-tight">Characters</h2>
          <span className="text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-md border border-primary/20 ml-2">
            CATALOG
          </span>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="ml-auto flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary text-white text-xs font-bold hover:bg-primary/90"
          >
            <Plus size={12} /> New
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Global catalog of personas. Builtin rows can&apos;t be deleted but
          editing one creates a new admin-source copy.
        </p>

        {loading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : catalog.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">
            No characters yet.
          </div>
        ) : (
          <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="text-left text-[10px] font-bold uppercase tracking-widest text-muted-foreground border-b border-border/20">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Global</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {catalog.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-border/10 last:border-0 text-sm"
                  >
                    <td className="px-4 py-3 font-bold">{c.name}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs max-w-xs truncate">
                      {c.description || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/40">
                        {c.source}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => void handleToggleGlobal(c)}
                        className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold border ${
                          c.global_enabled
                            ? "bg-green-400/10 text-green-400 border-green-400/30"
                            : "bg-muted/30 text-muted-foreground border-border/30"
                        }`}
                      >
                        {c.global_enabled ? (
                          <>
                            <Power size={10} /> on
                          </>
                        ) : (
                          <>
                            <PowerOff size={10} /> off
                          </>
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setEditing(c)}
                          className="p-1.5 rounded border border-border/40 bg-card/50 hover:bg-card text-xs"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          type="button"
                          disabled={c.source === "builtin"}
                          onClick={() => setDeleteTarget(c)}
                          title={
                            c.source === "builtin"
                              ? "Builtin characters cannot be deleted"
                              : "Delete"
                          }
                          className="p-1.5 rounded border border-red-400/30 bg-red-400/10 text-red-400 hover:bg-red-400/20 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <Trash2 size={11} />
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

      <CharacterUserAccessMatrix users={users} refreshKey={refreshKey} />

      {(editing || creating) && (
        <CharacterEditDialog
          initial={editing}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={handleSaved}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : ""}
        description="This removes the character from the catalog. Users who had it active will fall back to a builtin."
        confirmLabel="Delete"
        destructive
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
};

export default CharactersAdminSection;
