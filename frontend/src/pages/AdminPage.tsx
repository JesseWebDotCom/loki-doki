/**
 * AdminPage — user management table.
 *
 * Shows users with role + status badges and action buttons. If any
 * admin route returns 403 password_challenge_(required|expired), the
 * AdminPasswordPrompt modal pops, retries the original action on success.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
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
    <div className="min-h-screen bg-[#0A0A0A] p-8 text-neutral-100">
      <h1 className="mb-6 text-2xl font-bold">Admin · Users</h1>
      {error && (
        <div className="mb-4 rounded border border-red-900 bg-red-950/40 p-2 text-sm text-red-300">
          {error}
        </div>
      )}
      <table className="w-full max-w-3xl border-separate border-spacing-y-1">
        <thead className="text-left text-xs uppercase text-neutral-400">
          <tr>
            <th className="pl-3">User</th>
            <th>Role</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr
              key={u.id}
              className="bg-[#171717] text-sm"
              data-testid={`admin-row-${u.id}`}
            >
              <td className="rounded-l-md px-3 py-2">{u.username}</td>
              <td>
                <span className="rounded bg-violet-500/20 px-2 py-0.5 text-xs text-violet-300">
                  {u.role}
                </span>
              </td>
              <td>
                <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
                  {u.status}
                </span>
              </td>
              <td className="rounded-r-md py-2 pr-3">
                <div className="flex flex-wrap gap-1">
                  {u.status === "active" ? (
                    <button
                      onClick={() => act(u.id, "disable")}
                      className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
                    >
                      Disable
                    </button>
                  ) : (
                    <button
                      onClick={() => act(u.id, "enable")}
                      className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
                    >
                      Enable
                    </button>
                  )}
                  {u.role === "admin" ? (
                    <button
                      onClick={() => act(u.id, "demote")}
                      className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
                    >
                      Demote
                    </button>
                  ) : (
                    <button
                      onClick={() => act(u.id, "promote")}
                      className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
                    >
                      Promote
                    </button>
                  )}
                  <button
                    onClick={() => act(u.id, "delete")}
                    className="rounded bg-red-900/60 px-2 py-1 text-xs hover:bg-red-800"
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
