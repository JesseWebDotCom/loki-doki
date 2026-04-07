/**
 * AdminPage — user management table.
 *
 * Shows users with role + status badges and action buttons. If any
 * admin route returns 403 password_challenge_(required|expired), the
 * AdminPasswordPrompt modal pops, retries the original action on success.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { ShieldCheck, Shield, Users, Brain, Check, X, Trash2, AlertTriangle, Save, ScrollText } from "lucide-react";
import LogViewer from "../components/dev/LogViewer";
import CharactersAdminSection from "../components/admin/CharactersAdminSection";
import Sidebar from "../components/sidebar/Sidebar";
import { useAuth } from "../auth/useAuth";
import { AdminPasswordPrompt } from "../components/AdminPasswordPrompt";
import { getSettings, saveSettings } from "../lib/api";
import type { SettingsData } from "../lib/api";

type AdminUser = {
  id: number;
  username: string;
  role: "admin" | "user";
  status: "active" | "disabled" | "deleted";
};

type AdminPerson = { id: number; name: string; fact_count?: number };
type AdminFact = {
  id: number;
  subject: string;
  predicate: string;
  value: string;
  confidence: number;
  effective_confidence?: number;
  status: string;
  category: string;
};

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
}

const AdminPage: React.FC = () => {
  const { currentUser } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => Promise<void>) | null>(
    null,
  );
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [adminPeople, setAdminPeople] = useState<AdminPerson[]>([]);
  const [adminFacts, setAdminFacts] = useState<AdminFact[]>([]);
  const [factFilter, setFactFilter] = useState<string>("active,ambiguous,pending");
  const [newPerson, setNewPerson] = useState("");
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [adminPromptSaved, setAdminPromptSaved] = useState(false);

  useEffect(() => {
    void getSettings().then(setSettings).catch(() => {});
  }, []);

  const saveAdminPrompt = useCallback(async () => {
    if (!settings) return;
    try {
      await saveSettings(settings);
      setAdminPromptSaved(true);
      setTimeout(() => setAdminPromptSaved(false), 2000);
    } catch {
      setError("failed to save admin prompt");
    }
  }, [settings]);

  const loadUserMemory = useCallback(
    async (uid: number) => {
      const [pr, fr] = await Promise.all([
        api(`/api/v1/admin/users/${uid}/people`),
        api(`/api/v1/admin/users/${uid}/facts?status=${factFilter}`),
      ]);
      if (pr.ok) setAdminPeople(((await pr.json()) as { people: AdminPerson[] }).people);
      if (fr.ok) setAdminFacts(((await fr.json()) as { facts: AdminFact[] }).facts);
    },
    [factFilter],
  );

  useEffect(() => {
    if (selectedUser) void loadUserMemory(selectedUser.id);
  }, [selectedUser, loadUserMemory]);

  const adminFactAction = useCallback(
    async (factId: number, action: "promote" | "reject" | "delete") => {
      const method = action === "delete" ? "DELETE" : "POST";
      const path =
        action === "delete"
          ? `/api/v1/admin/facts/${factId}`
          : `/api/v1/admin/facts/${factId}/${action}`;
      const r = await api(path, { method });
      if (!r.ok) {
        setError(`${action} failed`);
        return;
      }
      if (selectedUser) void loadUserMemory(selectedUser.id);
    },
    [selectedUser, loadUserMemory],
  );

  const adminCreatePerson = useCallback(async () => {
    if (!selectedUser || !newPerson.trim()) return;
    const r = await api(`/api/v1/admin/users/${selectedUser.id}/people`, {
      method: "POST",
      body: JSON.stringify({ name: newPerson.trim() }),
    });
    if (r.ok) {
      setNewPerson("");
      void loadUserMemory(selectedUser.id);
    }
  }, [selectedUser, newPerson, loadUserMemory]);

  const adminDeletePerson = useCallback(
    async (personId: number) => {
      if (!confirm("Delete this person and cascade their facts?")) return;
      const r = await api(`/api/v1/admin/people/${personId}`, { method: "DELETE" });
      if (r.ok && selectedUser) void loadUserMemory(selectedUser.id);
    },
    [selectedUser, loadUserMemory],
  );

  const refresh = useCallback(async () => {
    const r = await api("/api/v1/admin/users");
    if (r.status === 403) {
      const detail = (await r.json().catch(() => ({}))) as { detail?: string };
      if (detail.detail?.startsWith("password_challenge")) {
        setPendingAction(() => refresh);
        return;
      }
      setError("forbidden");
      return;
    }
    if (!r.ok) {
      setError(`load failed (${r.status})`);
      return;
    }
    const data = (await r.json()) as { users: AdminUser[] };
    setUsers(data.users);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleResetMemory = useCallback(async () => {
    const confirmed = confirm(
      "Wipe ALL memory? This deletes every fact, person, relationship, " +
      "ambiguity group, session, and message for every user.\n\n" +
      "Users, projects, and admin login are preserved.\n\n" +
      "This cannot be undone.",
    );
    if (!confirmed) return;
    const fn = async () => {
      const r = await api("/api/v1/admin/reset-memory", { method: "POST" });
      if (r.status === 403) {
        const detail = (await r.json().catch(() => ({}))) as { detail?: string };
        if (detail.detail?.startsWith("password_challenge")) {
          setPendingAction(() => fn);
          return;
        }
      }
      if (!r.ok) {
        setError(`reset failed (${r.status})`);
        return;
      }
      const data = (await r.json()) as { wiped: Record<string, number> };
      const total = Object.values(data.wiped).reduce((s, n) => s + (n || 0), 0);
      setError(null);
      alert(`Memory wiped: ${total} rows across ${Object.keys(data.wiped).length} tables.`);
      if (selectedUser) void loadUserMemory(selectedUser.id);
      void refresh();
    };
    await fn();
  }, [selectedUser, loadUserMemory, refresh]);

  const act = useCallback(
    async (id: number, action: string) => {
      const fn = async () => {
        const r = await api(`/api/v1/admin/users/${id}/${action}`, {
          method: "POST",
        });
        if (r.status === 403) {
          const detail = (await r.json().catch(() => ({}))) as { detail?: string };
          if (detail.detail?.startsWith("password_challenge")) {
            setPendingAction(() => fn);
            return;
          }
        }
        if (!r.ok) {
          setError(`${action} failed (${r.status})`);
          return;
        }
        await refresh();
      };
      await fn();
    },
    [refresh],
  );

  if (currentUser && currentUser.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase="idle" />

      <main className="flex-1 flex flex-col relative bg-background shadow-inner overflow-y-auto">
        <header className="p-10 border-b border-border/10">
          <div className="max-w-4xl mx-auto flex items-center gap-4">
            <div className="p-3 rounded-2xl bg-primary/10 border border-primary/20 text-primary shadow-m2">
              <ShieldCheck size={28} />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Admin Panel</h1>
              <p className="text-muted-foreground text-sm font-medium">Manage users, roles, and access.</p>
            </div>
          </div>
        </header>

        <section className="p-10 flex-1">
          <div className="max-w-4xl mx-auto space-y-12">
            {error && (
              <div className="rounded-xl border border-red-400/30 bg-red-400/5 p-4 text-sm text-red-300">
                {error}
              </div>
            )}

            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-border/10 pb-4">
                <Users className="text-primary w-5 h-5" />
                <h2 className="text-xl font-bold tracking-tight">Users</h2>
                <span className="text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-md border border-primary/20 ml-2">
                  {users.length}
                </span>
              </div>

              <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden shadow-m1">
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-[10px] font-bold text-muted-foreground uppercase tracking-widest border-b border-border/20">
                      <th className="px-4 py-3">User</th>
                      <th className="px-4 py-3">Role</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr
                        key={u.id}
                        className={`border-b border-border/10 last:border-0 text-sm hover:bg-card/30 transition-colors cursor-pointer ${selectedUser?.id === u.id ? "bg-primary/5" : ""}`}
                        data-testid={`admin-row-${u.id}`}
                        onClick={() => setSelectedUser(u)}
                      >
                        <td className="px-4 py-3 font-bold">{u.username}</td>
                        <td className="px-4 py-3">
                          <span className="rounded-md bg-primary/10 border border-primary/20 px-2 py-0.5 text-[10px] font-bold text-primary uppercase tracking-widest">
                            {u.role}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border ${
                            u.status === "active"
                              ? "bg-green-400/10 text-green-400 border-green-400/20"
                              : "bg-muted/30 text-muted-foreground border-border/30"
                          }`}>
                            {u.status}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1.5 justify-end">
                            {u.status === "active" ? (
                              <button
                                onClick={() => act(u.id, "disable")}
                                className="rounded-md border border-border/40 bg-card/50 px-2.5 py-1 text-xs font-bold hover:bg-card hover:border-border/70 transition-all"
                              >
                                Disable
                              </button>
                            ) : (
                              <button
                                onClick={() => act(u.id, "enable")}
                                className="rounded-md border border-border/40 bg-card/50 px-2.5 py-1 text-xs font-bold hover:bg-card hover:border-border/70 transition-all"
                              >
                                Enable
                              </button>
                            )}
                            {u.role === "admin" ? (
                              <button
                                onClick={() => act(u.id, "demote")}
                                className="rounded-md border border-border/40 bg-card/50 px-2.5 py-1 text-xs font-bold hover:bg-card hover:border-border/70 transition-all"
                              >
                                Demote
                              </button>
                            ) : (
                              <button
                                onClick={() => act(u.id, "promote")}
                                className="rounded-md border border-border/40 bg-card/50 px-2.5 py-1 text-xs font-bold hover:bg-card hover:border-border/70 transition-all"
                              >
                                Promote
                              </button>
                            )}
                            <button
                              onClick={() => act(u.id, "delete")}
                              className="rounded-md border border-red-400/30 bg-red-400/10 px-2.5 py-1 text-xs font-bold text-red-400 hover:bg-red-400/20 transition-all"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {users.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-4 py-8 text-center text-xs text-muted-foreground italic">
                          No users found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Character catalog + per-user access */}
            <CharactersAdminSection
              users={users.filter((u) => u.status !== "deleted")}
            />

            {/* Backend logs */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-border/10 pb-4">
                <ScrollText className="text-primary w-5 h-5" />
                <h2 className="text-xl font-bold tracking-tight">Backend Logs</h2>
              </div>
              <LogViewer height="h-80" />
            </div>

            {/* Admin Controls — moved from Settings */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-border/10 pb-4">
                <Shield className="text-red-400 w-5 h-5" />
                <h2 className="text-xl font-bold tracking-tight">Admin Controls</h2>
                <span className="text-[10px] font-bold text-red-400 bg-red-400/10 px-2 py-0.5 rounded-md border border-red-400/20 ml-2">
                  TIER 1 — HIGHEST PRIORITY
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Admin rules override all other prompts. Use this for parental controls or safety boundaries.
              </p>
              <textarea
                value={settings?.admin_prompt ?? ""}
                onChange={(e) =>
                  setSettings((prev) =>
                    prev ? { ...prev, admin_prompt: e.target.value } : prev,
                  )
                }
                placeholder="Example: No profanity. Keep all responses family-friendly and safe for children."
                rows={3}
                disabled={!settings}
                className="w-full bg-card/50 border border-border/50 rounded-xl p-4 focus:outline-none focus:border-red-400/50 focus:ring-4 focus:ring-red-400/5 transition-all text-sm font-medium resize-none disabled:opacity-50"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void saveAdminPrompt()}
                  disabled={!settings}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-xs transition-all shadow-m1 ${
                    adminPromptSaved
                      ? "bg-green-500/20 text-green-400 border border-green-500/30"
                      : "bg-primary text-white hover:bg-primary/90 active:scale-95"
                  } disabled:opacity-50`}
                >
                  {adminPromptSaved ? <Check size={14} /> : <Save size={14} />}
                  {adminPromptSaved ? "Saved" : "Save Admin Prompt"}
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-red-400/20 pb-4">
                <AlertTriangle className="text-red-400 w-5 h-5" />
                <h2 className="text-xl font-bold tracking-tight text-red-400">
                  Danger Zone
                </h2>
              </div>
              <div className="rounded-xl border border-red-400/30 bg-red-400/5 p-4 flex items-center justify-between gap-4">
                <div className="text-xs">
                  <div className="font-bold text-red-300 mb-1">Reset memory</div>
                  <div className="text-muted-foreground">
                    Wipes all facts, people, relationships, ambiguity groups,
                    sessions, and messages for every user. Preserves users,
                    projects, and your admin login. Useful for retesting fact
                    extraction from a clean slate.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleResetMemory()}
                  className="shrink-0 rounded-md border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs font-bold text-red-300 hover:bg-red-400/20 transition-all"
                >
                  Reset Memory
                </button>
              </div>
            </div>

            {selectedUser && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-border/10 pb-4">
                  <Brain className="text-primary w-5 h-5" />
                  <h2 className="text-xl font-bold tracking-tight">
                    Memory: {selectedUser.username}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setSelectedUser(null)}
                    className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    close
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-6">
                  <div className="rounded-xl border border-border/30 bg-card/50 p-4 space-y-3">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      People ({adminPeople.length})
                    </div>
                    <div className="flex gap-2">
                      <input
                        value={newPerson}
                        onChange={(e) => setNewPerson(e.target.value)}
                        placeholder="Add person…"
                        className="flex-1 bg-background border border-border/40 rounded-md px-2 py-1 text-xs"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void adminCreatePerson();
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => void adminCreatePerson()}
                        className="text-xs px-2 py-1 rounded-md bg-primary/10 border border-primary/30 text-primary"
                      >
                        Add
                      </button>
                    </div>
                    <div className="space-y-1 max-h-64 overflow-y-auto">
                      {adminPeople.map((p) => (
                        <div
                          key={p.id}
                          className="flex items-center gap-2 text-xs p-2 rounded bg-background/40 border border-border/20"
                        >
                          <span className="flex-1 font-medium">{p.name}</span>
                          <span className="text-muted-foreground">
                            {p.fact_count ?? 0} facts
                          </span>
                          <button
                            type="button"
                            onClick={() => void adminDeletePerson(p.id)}
                            className="p-1 rounded hover:bg-red-400/10 text-red-400"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-border/30 bg-card/50 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                        Facts ({adminFacts.length})
                      </div>
                      <select
                        value={factFilter}
                        onChange={(e) => setFactFilter(e.target.value)}
                        className="text-[10px] bg-background border border-border/40 rounded px-1 py-0.5"
                      >
                        <option value="active,ambiguous,pending">Live</option>
                        <option value="pending,ambiguous">Pending</option>
                        <option value="active">Active</option>
                        <option value="rejected">Rejected</option>
                        <option value="superseded">Superseded</option>
                      </select>
                    </div>
                    <div className="space-y-1 max-h-64 overflow-y-auto">
                      {adminFacts.map((f) => (
                        <div
                          key={f.id}
                          className="flex items-start gap-2 text-xs p-2 rounded bg-background/40 border border-border/20"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-[10px] text-muted-foreground">
                              {f.subject}.{f.predicate}
                            </div>
                            <div className="font-medium truncate">{f.value}</div>
                            <div className="text-[10px] text-muted-foreground">
                              {f.status} •{" "}
                              {Math.round(
                                (f.effective_confidence ?? f.confidence) * 100,
                              )}
                              %
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void adminFactAction(f.id, "promote")}
                            title="Promote"
                            className="p-1 rounded hover:bg-green-400/10 text-green-400"
                          >
                            <Check size={11} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void adminFactAction(f.id, "reject")}
                            title="Reject"
                            className="p-1 rounded hover:bg-amber-400/10 text-amber-400"
                          >
                            <X size={11} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void adminFactAction(f.id, "delete")}
                            title="Delete"
                            className="p-1 rounded hover:bg-red-400/10 text-red-400"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>

      {pendingAction && (
        <AdminPasswordPrompt
          onSuccess={async () => {
            const fn = pendingAction;
            setPendingAction(null);
            await fn();
          }}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </div>
  );
};

export default AdminPage;
