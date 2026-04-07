/**
 * AuthProvider — owns currentUser + bootstrap state.
 *
 * Calls /api/v1/auth/me on mount and exposes login/logout/bootstrap/
 * challengeAdmin to the rest of the app. The 409 response from /me is
 * the canonical "needs bootstrap" signal so the wizard route knows when
 * to take over.
 */
import React, {
  createContext,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type CurrentUser = {
  id: number;
  username: string;
  role: "admin" | "user";
  admin_fresh?: boolean;
};

export type AuthState = {
  currentUser: CurrentUser | null;
  needsBootstrap: boolean;
  loading: boolean;
  error: string | null;
  login: (username: string, pin: string) => Promise<void>;
  logout: () => Promise<void>;
  bootstrap: (
    username: string,
    pin: string,
    password: string,
  ) => Promise<void>;
  challengeAdmin: (password: string) => Promise<void>;
  refresh: () => Promise<void>;
};

export const AuthContext = createContext<AuthState | null>(null);

const json = { "Content-Type": "application/json" };

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { credentials: "include", ...init });
}

export const AuthProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await call("/api/v1/auth/me");
      if (r.status === 409) {
        setNeedsBootstrap(true);
        setCurrentUser(null);
      } else if (r.status === 200) {
        setNeedsBootstrap(false);
        setCurrentUser((await r.json()) as CurrentUser);
      } else {
        setNeedsBootstrap(false);
        setCurrentUser(null);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (username: string, pin: string) => {
      const r = await call("/api/v1/auth/login", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ username, pin }),
      });
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))) as {
          detail?: string;
        };
        throw new Error(detail.detail || `login failed (${r.status})`);
      }
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await call("/api/v1/auth/logout", { method: "POST" });
    await refresh();
  }, [refresh]);

  const bootstrap = useCallback(
    async (username: string, pin: string, password: string) => {
      const r = await call("/api/v1/auth/bootstrap", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ username, pin, password }),
      });
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))) as {
          detail?: string;
        };
        throw new Error(detail.detail || `bootstrap failed (${r.status})`);
      }
      await refresh();
    },
    [refresh],
  );

  const challengeAdmin = useCallback(
    async (password: string) => {
      const r = await call("/api/v1/auth/challenge-admin", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))) as {
          detail?: string;
        };
        throw new Error(detail.detail || `challenge failed (${r.status})`);
      }
      await refresh();
    },
    [refresh],
  );

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        needsBootstrap,
        loading,
        error,
        login,
        logout,
        bootstrap,
        challengeAdmin,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
