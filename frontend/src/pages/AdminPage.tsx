/**
 * AdminPage — user management table.
 *
 * Shows users with role + status badges and action buttons. If any
 * admin route returns 403 password_challenge_(required|expired), the
 * AdminPasswordPrompt modal pops, retries the original action on success.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { ShieldCheck, Users } from "lucide-react";
import Sidebar from "../components/sidebar/Sidebar";
import { useAuth } from "../auth/useAuth";
import { AdminPasswordPrompt } from "../components/AdminPasswordPrompt";

type AdminUser = {
  id: number;
  username: string;
  role: "admin" | "user";
  status: "active" | "disabled" | "deleted";
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
                        className="border-b border-border/10 last:border-0 text-sm hover:bg-card/30 transition-colors"
                        data-testid={`admin-row-${u.id}`}
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
