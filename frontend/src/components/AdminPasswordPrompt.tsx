/** Reusable modal for the 15-minute admin password challenge. */
import React, { useState } from "react";
import { useAuth } from "../auth/useAuth";

export const AdminPasswordPrompt: React.FC<{
  onSuccess: () => void;
  onCancel: () => void;
}> = ({ onSuccess, onCancel }) => {
  const { challengeAdmin } = useAuth();
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await challengeAdmin(pwd);
      onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-neutral-800 bg-[#171717] p-6 shadow-2xl"
        data-testid="admin-prompt"
      >
        <h2 className="mb-4 text-lg font-semibold text-white">
          Confirm admin password
        </h2>
        <input
          type="password"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          autoFocus
          className="mb-4 w-full rounded-md border border-neutral-700 bg-[#0A0A0A] px-3 py-2 text-neutral-100 focus:border-violet-400 focus:outline-none"
          data-testid="admin-prompt-input"
        />
        {error && (
          <p className="mb-3 text-sm text-red-300">{error}</p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-violet-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-50"
          >
            Confirm
          </button>
        </div>
      </form>
    </div>
  );
};
