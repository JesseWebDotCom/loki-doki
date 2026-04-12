/** LoginPage — username + PIN. */
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const card =
  "w-full max-w-lg rounded-[1.75rem] border border-white/8 bg-[#171717] p-10 shadow-2xl shadow-black/30";
const label = "mb-2 block text-sm font-medium text-neutral-300";
const input =
  "w-full rounded-xl border border-neutral-700 bg-[#0A0A0A] px-4 py-3 text-base text-neutral-100 focus:border-violet-400 focus:outline-none";
const btn =
  "w-full rounded-xl bg-violet-500 px-4 py-3 text-base font-semibold text-white hover:bg-violet-400 disabled:opacity-50";

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
    <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] px-6 py-10">
      <form className={card} onSubmit={onSubmit}>
        <h1 className="mb-2 text-4xl font-bold tracking-tight text-white">Sign in</h1>
        <p className="mb-8 text-base leading-7 text-neutral-400">
          Unlock LokiDoki with your username and PIN.
        </p>
        <div className="mb-5">
          <label className={label}>Username</label>
          <input
            className={input}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            data-testid="login-username"
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
          />
        </div>
        {error && (
          <div className="mb-5 rounded-xl border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
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
