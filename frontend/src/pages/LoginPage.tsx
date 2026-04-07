/** LoginPage — username + PIN. */
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";

const card =
  "w-full max-w-md rounded-xl border border-neutral-800 bg-[#171717] p-8 shadow-2xl";
const label = "block text-sm font-medium text-neutral-300 mb-1";
const input =
  "w-full rounded-md border border-neutral-700 bg-[#0A0A0A] px-3 py-2 text-neutral-100 focus:border-violet-400 focus:outline-none";
const btn =
  "w-full rounded-md bg-violet-500 px-4 py-2 font-semibold text-white hover:bg-violet-400 disabled:opacity-50";

const LoginPage: React.FC = () => {
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
    <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A]">
      <form className={card} onSubmit={onSubmit}>
        <h1 className="mb-6 text-2xl font-bold text-white">Sign in</h1>
        <div className="mb-4">
          <label className={label}>Username</label>
          <input
            className={input}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            data-testid="login-username"
          />
        </div>
        <div className="mb-6">
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
          <div className="mb-4 rounded-md border border-red-900 bg-red-950/40 p-2 text-sm text-red-300">
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
