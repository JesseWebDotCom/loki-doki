/**
 * WizardPage — first-run admin bootstrap.
 *
 * Onyx Material surface (#0A0A0A background, #171717 elevated card,
 * Material purple accent). Form validates: 4-8 digit PIN, matching
 * confirmations, password ≥ 8 chars. POST /api/v1/auth/bootstrap.
 */
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

const WizardPage: React.FC = () => {
  useDocumentTitle('Welcome');
  const { bootstrap } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [pwd, setPwd] = useState("");
  const [pwd2, setPwd2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validate = (): string | null => {
    if (!username.trim()) return "Username required";
    if (!/^\d{4,8}$/.test(pin)) return "PIN must be 4–8 digits";
    if (pin !== pin2) return "PINs do not match";
    if (pwd.length < 8) return "Password must be at least 8 characters";
    if (pwd !== pwd2) return "Passwords do not match";
    return null;
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await bootstrap(username.trim(), pin, pwd);
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
        <h1 className="mb-2 text-4xl font-bold tracking-tight text-white">Welcome to LokiDoki</h1>
        <p className="mb-8 text-base leading-7 text-neutral-400">
          Create the first admin account.
        </p>

        <div className="mb-5">
          <label className={label}>Username</label>
          <input
            className={input}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            data-testid="wizard-username"
          />
        </div>
        <div className="mb-5">
          <label className={label}>PIN (4–8 digits)</label>
          <input
            className={input}
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            inputMode="numeric"
            autoComplete="new-password"
            data-testid="wizard-pin"
          />
        </div>
        <div className="mb-5">
          <label className={label}>Confirm PIN</label>
          <input
            className={input}
            type="password"
            value={pin2}
            onChange={(e) => setPin2(e.target.value)}
            inputMode="numeric"
            autoComplete="new-password"
            data-testid="wizard-pin2"
          />
        </div>
        <div className="mb-5">
          <label className={label}>Admin Password</label>
          <input
            className={input}
            type="password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            data-testid="wizard-pwd"
          />
        </div>
        <div className="mb-8">
          <label className={label}>Confirm Password</label>
          <input
            className={input}
            type="password"
            value={pwd2}
            onChange={(e) => setPwd2(e.target.value)}
            data-testid="wizard-pwd2"
          />
        </div>

        {error && (
          <div
            data-testid="wizard-error"
            className="mb-5 rounded-xl border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300"
          >
            {error}
          </div>
        )}

        <button className={btn} disabled={busy} data-testid="wizard-submit">
          {busy ? "Creating…" : "Create Admin"}
        </button>
      </form>
    </div>
  );
};

export default WizardPage;
