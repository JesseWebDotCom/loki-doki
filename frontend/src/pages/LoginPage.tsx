/** LoginPage — username + PIN. */
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const card =
  "w-full max-w-lg rounded-[1.75rem] border border-border bg-card p-10 shadow-m4 transition-all";
const label = "mb-2 block text-sm font-medium text-muted-foreground";
const input =
  "w-full rounded-xl border border-input bg-background px-4 py-3 text-base text-foreground focus:ring-2 focus:ring-ring focus:outline-none transition-all";
const btn =
  "w-full rounded-xl bg-primary px-4 py-3 text-base font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-all active:scale-[0.98]";

const LoginPage: React.FC = () => {
  useDocumentTitle('Sign in');
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !pin.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), pin);
      navigate("/", { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-6 py-10">
      <form className={card} onSubmit={onSubmit}>
        <h1 className="mb-2 text-4xl font-bold tracking-tight text-foreground">Sign in</h1>
        <p className="mb-8 text-base leading-7 text-muted-foreground">
          Unlock LokiDoki with your username and PIN.
        </p>
        <div className="mb-5">
          <label className={label}>Username</label>
          <input
            className={input}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            data-testid="login-username"
            placeholder="Username"
          />
        </div>
        <div className="mb-8">
          <label className={label}>PIN</label>
          <input
            className={input}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            type="password"
            inputMode="numeric"
            data-testid="login-pin"
            placeholder="••••"
          />
        </div>
        {error && (
          <div className="mb-5 rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <button className={btn} disabled={busy} data-testid="login-submit">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
};

export default LoginPage;
