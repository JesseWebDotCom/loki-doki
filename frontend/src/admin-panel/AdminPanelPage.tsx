/**
 * Admin/Settings/Dev pages — three distinct page components built on
 * AdminPanelLayout. Each page exposes only the nav groups relevant to
 * its audience:
 *
 *   /settings  → Personalization (everyone)
 *   /admin     → Permissions + Danger (admin only)
 *   /dev       → Developer        (admin only)
 *
 * Admin-only sections are gated by a 15-minute password challenge
 * that runs *before* the section content mounts.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  Check, Cpu, Save, X, Trash2, Brain, AlertTriangle, Shield, ScrollText, Wrench, Users as UsersIcon,
} from 'lucide-react';
import AdminPanelLayout from './AdminPanelLayout';
import type { SectionDef, SectionId } from './sections';
import { useAuth } from '../auth/useAuth';
import { AdminPasswordPrompt } from '../components/AdminPasswordPrompt';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import LogViewer from '../components/dev/LogViewer';
import AudioSection from '../components/settings/AudioSection';
import AppearanceSection from '../components/settings/AppearanceSection';
import CharactersSection from '../components/settings/CharactersSection';
import RelationshipAliasesSection from '../components/settings/RelationshipAliasesSection';
import SkillsSection from '../components/settings/SkillsSection';
import CharactersAdminSection from '../components/admin/CharactersAdminSection';
import { getSystemInfo, getSettings, saveSettings } from '../lib/api';
import type { SettingsData } from '../lib/api';
import type { SystemInfo } from '../lib/api-types';

type AdminUser = { id: number; username: string; role: 'admin' | 'user'; status: 'active' | 'disabled' | 'deleted' };
type AdminPerson = { id: number; name: string; fact_count?: number };
type AdminFact = {
  id: number; subject: string; predicate: string; value: string;
  confidence: number; effective_confidence?: number; status: string; category: string;
};

const api = (path: string, init?: RequestInit) =>
  fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });

// ────────────────────────────────────────────────────────────────
// Page wrappers — one per audience.
// ────────────────────────────────────────────────────────────────

const renderGated = (s: SectionDef) => (
  <SectionGate section={s}>
    <SectionBody section={s} />
  </SectionGate>
);

export const SettingsPage: React.FC = () => (
  <AdminPanelLayout
    allowedGroups={['Personalization']}
    basePath="/settings"
    pageLabel="Settings"
    renderSection={renderGated}
  />
);

export const AdminPage: React.FC = () => {
  const { currentUser } = useAuth();
  if (currentUser && currentUser.role !== 'admin') return <Navigate to="/" replace />;
  return (
    <AdminPanelLayout
      allowedGroups={['Permissions', 'Danger']}
      basePath="/admin"
      pageLabel="Admin Panel"
      renderSection={renderGated}
    />
  );
};

export const DevToolsPage: React.FC = () => {
  const { currentUser } = useAuth();
  if (currentUser && currentUser.role !== 'admin') return <Navigate to="/" replace />;
  return (
    <AdminPanelLayout
      allowedGroups={['Developer']}
      basePath="/dev"
      pageLabel="Dev Tools"
      renderSection={renderGated}
    />
  );
};

// ────────────────────────────────────────────────────────────────
// Password gate: probes /api/v1/admin/users on mount when entering
// any admin-only section. Renders the prompt before the body until
// the challenge clears.
// ────────────────────────────────────────────────────────────────
const SectionGate: React.FC<{ section: SectionDef; children: React.ReactNode }> = ({ section, children }) => {
  const [needsChallenge, setNeedsChallenge] = useState(false);
  const [checking, setChecking] = useState(section.requiresChallenge ?? false);

  const probe = useCallback(async () => {
    if (!section.requiresChallenge) {
      setChecking(false);
      return;
    }
    setChecking(true);
    const r = await api('/api/v1/admin/users');
    if (r.status === 403) {
      const detail = (await r.json().catch(() => ({}))) as { detail?: string };
      if (detail.detail?.startsWith('password_challenge')) {
        setNeedsChallenge(true);
        setChecking(false);
        return;
      }
    }
    setNeedsChallenge(false);
    setChecking(false);
  }, [section.requiresChallenge]);

  useEffect(() => { void probe(); }, [probe]);

  if (checking) {
    return (
      <div className="text-xs text-muted-foreground italic py-12 text-center">
        Verifying admin session…
      </div>
    );
  }
  if (needsChallenge) {
    return (
      <AdminPasswordPrompt
        onSuccess={() => { setNeedsChallenge(false); void probe(); }}
        onCancel={() => { window.location.href = '/'; }}
      />
    );
  }
  return <>{children}</>;
};

// ────────────────────────────────────────────────────────────────
// SectionBody — renders the active section pane.
// ────────────────────────────────────────────────────────────────
const SectionBody: React.FC<{ section: SectionDef }> = ({ section }) => {
  switch (section.id as SectionId) {
    case 'general':           return <GeneralPane />;
    case 'characters':        return <CharactersSection />;
    case 'audio':             return <AudioSection />;
    case 'skills':            return <SkillsSection />;
    case 'admin-skills':      return <SkillsSection enableTesting />;
    case 'appearance':        return <AppearanceSection />;
    case 'users':             return <UsersPane />;
    case 'character-catalog': return <CharacterCatalogPane />;
    case 'controls':          return <ControlsPane />;
    case 'memory':            return <MemoryPane />;
    case 'danger':            return <DangerPane />;
    case 'logs':              return <LogsPane />;
    case 'tools':             return <ToolsPane />;
  }
};

// ── Personalization panes ──────────────────────────────────────

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
};

const barWidth = (pct: number) => `${Math.min(Math.max(pct, 0), 100)}%`;

const MetricBar: React.FC<{ label: string; pct: number; detail?: string; color: string }> = ({ label, pct, detail, color }) => (
  <div className="space-y-1">
    <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
      <span>{label}</span>
      <span className="text-foreground">{pct.toFixed(1)}%</span>
    </div>
    <div className="relative h-7 overflow-hidden rounded-lg border border-border/30 bg-card/30">
      <div className={`absolute inset-y-0 left-0 ${color} transition-all duration-500`} style={{ width: barWidth(pct) }} />
    </div>
    {detail && <div className="text-[10px] text-muted-foreground">{detail}</div>}
  </div>
);

const StatusDot: React.FC<{ ok: boolean; label: string }> = ({ ok, label }) => (
  <div className="flex items-center gap-2">
    <div className={`w-2 h-2 rounded-full ${ok ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]' : 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.4)]'}`} />
    <span className="text-xs text-muted-foreground">{label}</span>
  </div>
);

const GeneralPane: React.FC = () => {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const load = () => { void getSystemInfo().then(setInfo).catch(() => setError(true)); };
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, []);

  if (error) return <div className="text-xs text-red-400 italic">Failed to load system info.</div>;
  if (!info) return <div className="text-xs text-muted-foreground italic">Loading system info…</div>;

  const { system: hw } = info;

  return (
    <div className="space-y-6">
      {/* Status + Runtime */}
      <div>
        <div className="flex items-center gap-2 border-b border-border/10 pb-4 mb-4">
          <Cpu className="text-primary w-5 h-5" />
          <h2 className="text-xl font-bold tracking-tight">Runtime</h2>
          <div className="ml-auto flex items-center gap-4">
            <StatusDot ok={info.ollama_ok} label="Ollama" />
            <StatusDot ok={info.internet_ok} label="Internet" />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Platform" value={info.platform} />
          <Stat label="Ollama" value={info.ollama_version || 'unavailable'} accent={info.ollama_ok ? 'text-green-400' : 'text-red-400'} />
          <Stat label="Fast Model" value={info.fast_model} accent="text-green-400" />
          <Stat label="Thinking Model" value={info.thinking_model} accent="text-primary" />
        </div>
      </div>

      {/* Hardware: CPU / Memory / Disk */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">System Resources</div>
        <div className="rounded-xl border border-border/30 bg-card/50 p-4 space-y-3">
          <MetricBar label="CPU" pct={hw.cpu.load_percent} detail={`${hw.cpu.cores} cores`} color="bg-cyan-400/20" />
          <MetricBar label="Memory" pct={hw.memory.used_percent} detail={`${formatBytes(hw.memory.used_bytes)} / ${formatBytes(hw.memory.total_bytes)}`} color="bg-violet-400/20" />
          <MetricBar label="Disk" pct={hw.disk.used_percent} detail={`${formatBytes(hw.disk.used_bytes)} / ${formatBytes(hw.disk.total_bytes)}`} color="bg-rose-400/20" />
        </div>
      </div>

      {/* Tracked Processes */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">Processes</div>
        <div className="grid grid-cols-2 gap-3">
          {info.processes.map((p) => (
            <div key={p.label} className="rounded-xl border border-border/30 bg-card/50 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-bold">{p.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest border ${
                  p.running
                    ? 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20'
                    : 'bg-card/60 text-muted-foreground border-border/30'
                }`}>
                  {p.running ? 'Running' : 'Idle'}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <div>CPU: <span className="text-foreground">{p.cpu_percent.toFixed(1)}%</span></div>
                <div>RAM: <span className="text-foreground">{formatBytes(p.memory_bytes)}</span></div>
                <div>PID: <span className="text-foreground font-mono">{p.pid ?? 'n/a'}</span></div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Storage Buckets */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">Storage</div>
        <div className="grid grid-cols-2 gap-3">
          {info.storage.map((b) => (
            <div key={b.key} className="rounded-xl border border-border/30 bg-card/50 p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{b.label}</div>
                <div className="text-[10px] text-muted-foreground truncate">{b.path}</div>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest border ${
                b.exists
                  ? 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20'
                  : 'bg-card/60 text-muted-foreground border-border/30'
              }`}>
                {b.exists ? formatBytes(b.size_bytes) : 'Missing'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Loaded Models (Ollama RAM) */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
          Models in Memory ({info.loaded_models.length})
        </div>
        {info.loaded_models.length === 0 ? (
          <div className="text-xs text-muted-foreground italic p-3 rounded-xl bg-card/50 border border-border/30">
            No models currently loaded.
          </div>
        ) : (
          <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="text-left text-[10px] font-bold text-muted-foreground uppercase tracking-widest border-b border-border/20">
                  <th className="px-4 py-2">Model</th>
                  <th className="px-4 py-2">RAM</th>
                  <th className="px-4 py-2">VRAM</th>
                  <th className="px-4 py-2">Expires</th>
                </tr>
              </thead>
              <tbody>
                {info.loaded_models.map((m) => (
                  <tr key={m.name} className="border-b border-border/10 last:border-0 text-xs">
                    <td className="px-4 py-2 font-bold font-mono">{m.name}</td>
                    <td className="px-4 py-2 text-muted-foreground">{formatBytes(m.size)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{formatBytes(m.size_vram)}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {m.expires_at ? new Date(m.expires_at).toLocaleTimeString() : 'persistent'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Available Models */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
          Available Models ({info.available_models.length})
        </div>
        {info.available_models.length === 0 ? (
          <div className="text-xs text-muted-foreground italic p-3 rounded-xl bg-card/50 border border-border/30">
            No models found in Ollama.
          </div>
        ) : (
          <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="text-left text-[10px] font-bold text-muted-foreground uppercase tracking-widest border-b border-border/20">
                  <th className="px-4 py-2">Model</th>
                  <th className="px-4 py-2">Params</th>
                  <th className="px-4 py-2">Quant</th>
                  <th className="px-4 py-2">Size</th>
                  <th className="px-4 py-2">Family</th>
                </tr>
              </thead>
              <tbody>
                {info.available_models.map((m) => {
                  const isActive = m.name === info.fast_model || m.name === info.thinking_model;
                  return (
                    <tr key={m.name} className={`border-b border-border/10 last:border-0 text-xs ${isActive ? 'bg-primary/5' : ''}`}>
                      <td className="px-4 py-2 font-mono font-bold">
                        {m.name}
                        {m.name === info.fast_model && (
                          <span className="ml-2 text-[9px] font-bold text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded border border-green-400/20">FAST</span>
                        )}
                        {m.name === info.thinking_model && (
                          <span className="ml-2 text-[9px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded border border-primary/20">THINK</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{m.parameter_size || '—'}</td>
                      <td className="px-4 py-2 text-muted-foreground">{m.quantization || '—'}</td>
                      <td className="px-4 py-2 text-muted-foreground">{formatBytes(m.size)}</td>
                      <td className="px-4 py-2 text-muted-foreground">{m.family || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        LokiDoki v0.2 · {info.platform} · {info.fast_model}
      </p>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; accent?: string }> = ({ label, value, accent }) => (
  <div className="p-4 rounded-xl bg-card/50 border border-border/30">
    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-1">{label}</div>
    <div className={`text-sm font-bold font-mono ${accent ?? ''}`}>{value}</div>
  </div>
);

// ── Permissions panes ──────────────────────────────────────────

const useUsers = () => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const r = await api('/api/v1/admin/users');
    if (!r.ok) { setError(`load failed (${r.status})`); return; }
    const data = (await r.json()) as { users: AdminUser[] };
    setUsers(data.users);
    setError(null);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { users, error, refresh };
};

const UsersPane: React.FC = () => {
  const navigate = useNavigate();
  const { users, error, refresh } = useUsers();

  const act = async (id: number, action: string) => {
    const r = await api(`/api/v1/admin/users/${id}/${action}`, { method: 'POST' });
    if (r.ok) await refresh();
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-xl border border-red-400/30 bg-red-400/5 p-4 text-sm text-red-300">{error}</div>
      )}
      <div className="flex items-center gap-2 border-b border-border/10 pb-4">
        <UsersIcon className="text-primary w-5 h-5" />
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
                className="border-b border-border/10 last:border-0 text-sm hover:bg-card/30 transition-colors cursor-pointer"
                data-testid={`admin-row-${u.id}`}
                onClick={() => navigate(`/admin/memory?user=${u.id}`)}
              >
                <td className="px-4 py-3 font-bold">{u.username}</td>
                <td className="px-4 py-3">
                  <span className="rounded-md bg-primary/10 border border-primary/20 px-2 py-0.5 text-[10px] font-bold text-primary uppercase tracking-widest">
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border ${
                    u.status === 'active'
                      ? 'bg-green-400/10 text-green-400 border-green-400/20'
                      : 'bg-muted/30 text-muted-foreground border-border/30'
                  }`}>
                    {u.status}
                  </span>
                </td>
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <div className="flex flex-wrap gap-1.5 justify-end">
                    <button
                      onClick={() => void act(u.id, u.status === 'active' ? 'disable' : 'enable')}
                      className="rounded-md border border-border/40 bg-card/50 px-2.5 py-1 text-xs font-bold hover:bg-card hover:border-border/70 transition-all"
                    >
                      {u.status === 'active' ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={() => void act(u.id, u.role === 'admin' ? 'demote' : 'promote')}
                      className="rounded-md border border-border/40 bg-card/50 px-2.5 py-1 text-xs font-bold hover:bg-card hover:border-border/70 transition-all"
                    >
                      {u.role === 'admin' ? 'Demote' : 'Promote'}
                    </button>
                    <button
                      onClick={() => void act(u.id, 'delete')}
                      className="rounded-md border border-red-400/30 bg-red-400/10 px-2.5 py-1 text-xs font-bold text-red-400 hover:bg-red-400/20 transition-all"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-xs text-muted-foreground italic">No users found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const CharacterCatalogPane: React.FC = () => {
  const { users } = useUsers();
  return <CharactersAdminSection users={users.filter((u) => u.status !== 'deleted')} />;
};

const ControlsPane: React.FC = () => {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { void getSettings().then(setSettings).catch(() => {}); }, []);
  const save = async () => {
    if (!settings) return;
    await saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };
  return (
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
        value={settings?.admin_prompt ?? ''}
        onChange={(e) => settings && setSettings({ ...settings, admin_prompt: e.target.value })}
        placeholder="Example: No profanity. Keep all responses family-friendly and safe for children."
        rows={5}
        disabled={!settings}
        className="w-full bg-card/50 border border-border/50 rounded-xl p-4 focus:outline-none focus:border-red-400/50 focus:ring-4 focus:ring-red-400/5 transition-all text-sm font-medium resize-none disabled:opacity-50"
      />
      <RelationshipAliasesSection settings={settings} setSettings={setSettings} />
      <div className="flex justify-end">
        <button
          onClick={() => void save()}
          disabled={!settings}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-xs transition-all shadow-m1 ${
            saved
              ? 'bg-green-500/20 text-green-400 border border-green-500/30'
              : 'bg-primary text-white hover:bg-primary/90 active:scale-95'
          } disabled:opacity-50`}
        >
          {saved ? <Check size={14} /> : <Save size={14} />}
          {saved ? 'Saved' : 'Save Admin Prompt'}
        </button>
      </div>
    </div>
  );
};

const MemoryPane: React.FC = () => {
  const { users } = useUsers();
  const params = new URLSearchParams(window.location.search);
  const initialUserId = Number(params.get('user')) || null;
  const [selectedId, setSelectedId] = useState<number | null>(initialUserId);
  const [people, setPeople] = useState<AdminPerson[]>([]);
  const [facts, setFacts] = useState<AdminFact[]>([]);
  const [factFilter, setFactFilter] = useState('active,ambiguous,pending');
  const [newPerson, setNewPerson] = useState('');
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const load = useCallback(async (uid: number) => {
    const [pr, fr] = await Promise.all([
      api(`/api/v1/admin/users/${uid}/people`),
      api(`/api/v1/admin/users/${uid}/facts?status=${factFilter}`),
    ]);
    if (pr.ok) setPeople(((await pr.json()) as { people: AdminPerson[] }).people);
    if (fr.ok) setFacts(((await fr.json()) as { facts: AdminFact[] }).facts);
  }, [factFilter]);

  useEffect(() => { if (selectedId) void load(selectedId); }, [selectedId, load]);

  const factAction = async (id: number, action: 'promote' | 'reject' | 'delete') => {
    const method = action === 'delete' ? 'DELETE' : 'POST';
    const path = action === 'delete' ? `/api/v1/admin/facts/${id}` : `/api/v1/admin/facts/${id}/${action}`;
    await api(path, { method });
    if (selectedId) void load(selectedId);
  };

  const createPerson = async () => {
    if (!selectedId || !newPerson.trim()) return;
    await api(`/api/v1/admin/users/${selectedId}/people`, { method: 'POST', body: JSON.stringify({ name: newPerson.trim() }) });
    setNewPerson('');
    void load(selectedId);
  };

  const confirmDelete = async () => {
    if (pendingDelete == null) return;
    await api(`/api/v1/admin/people/${pendingDelete}`, { method: 'DELETE' });
    setPendingDelete(null);
    if (selectedId) void load(selectedId);
  };

  const sel = users.find((u) => u.id === selectedId);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 border-b border-border/10 pb-4">
        <Brain className="text-primary w-5 h-5" />
        <h2 className="text-xl font-bold tracking-tight">Memory Inspector</h2>
        <select
          value={selectedId ?? ''}
          onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
          className="ml-auto bg-card/50 border border-border/40 rounded-md px-3 py-1.5 text-xs font-medium focus:outline-none focus:border-primary/40"
        >
          <option value="">Select a user…</option>
          {users.filter((u) => u.status !== 'deleted').map((u) => (
            <option key={u.id} value={u.id}>{u.username}</option>
          ))}
        </select>
      </div>

      {!sel && (
        <div className="text-xs text-muted-foreground italic py-12 text-center">
          Pick a user from the dropdown above (or click a row in Users) to inspect their memory.
        </div>
      )}

      {sel && (
        <div className="grid grid-cols-2 gap-6">
          <div className="rounded-xl border border-border/30 bg-card/50 p-4 space-y-3">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              People ({people.length})
            </div>
            <div className="flex gap-2">
              <input
                value={newPerson}
                onChange={(e) => setNewPerson(e.target.value)}
                placeholder="Add person…"
                className="flex-1 bg-background border border-border/40 rounded-md px-2 py-1 text-xs"
                onKeyDown={(e) => { if (e.key === 'Enter') void createPerson(); }}
              />
              <button onClick={() => void createPerson()} className="text-xs px-2 py-1 rounded-md bg-primary/10 border border-primary/30 text-primary">
                Add
              </button>
            </div>
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {people.map((p) => (
                <div key={p.id} className="flex items-center gap-2 text-xs p-2 rounded bg-background/40 border border-border/20">
                  <span className="flex-1 font-medium">{p.name}</span>
                  <span className="text-muted-foreground">{p.fact_count ?? 0} facts</span>
                  <button onClick={() => setPendingDelete(p.id)} className="p-1 rounded hover:bg-red-400/10 text-red-400">
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border/30 bg-card/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Facts ({facts.length})
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
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {facts.map((f) => (
                <div key={f.id} className="flex items-start gap-2 text-xs p-2 rounded bg-background/40 border border-border/20">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-[10px] text-muted-foreground">{f.subject}.{f.predicate}</div>
                    <div className="font-medium truncate">{f.value}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {f.status} · {Math.round((f.effective_confidence ?? f.confidence) * 100)}%
                    </div>
                  </div>
                  <button onClick={() => void factAction(f.id, 'promote')} title="Promote" className="p-1 rounded hover:bg-green-400/10 text-green-400">
                    <Check size={11} />
                  </button>
                  <button onClick={() => void factAction(f.id, 'reject')} title="Reject" className="p-1 rounded hover:bg-amber-400/10 text-amber-400">
                    <X size={11} />
                  </button>
                  <button onClick={() => void factAction(f.id, 'delete')} title="Delete" className="p-1 rounded hover:bg-red-400/10 text-red-400">
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete person?"
        description="Delete this person and cascade their facts? This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};

// ── Danger pane ────────────────────────────────────────────────

const DangerPane: React.FC = () => {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const reset = async () => {
    setConfirmOpen(false);
    const r = await api('/api/v1/admin/reset-memory', { method: 'POST' });
    if (!r.ok) {
      setResultMsg(`Reset failed (${r.status}).`);
      return;
    }
    const data = (await r.json()) as { wiped: Record<string, number> };
    const total = Object.values(data.wiped).reduce((s, n) => s + (n || 0), 0);
    setResultMsg(`Memory wiped: ${total} rows across ${Object.keys(data.wiped).length} tables.`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 border-b border-red-400/20 pb-4">
        <AlertTriangle className="text-red-400 w-5 h-5" />
        <h2 className="text-xl font-bold tracking-tight text-red-400">Danger Zone</h2>
      </div>
      <div className="rounded-xl border border-red-400/30 bg-red-400/5 p-4 flex items-center justify-between gap-4">
        <div className="text-xs">
          <div className="font-bold text-red-300 mb-1">Reset memory</div>
          <div className="text-muted-foreground">
            Wipes all facts, people, relationships, ambiguity groups, sessions, and messages for every user.
            Preserves users, projects, and your admin login. Useful for retesting fact extraction from a clean slate.
          </div>
        </div>
        <button
          onClick={() => setConfirmOpen(true)}
          className="shrink-0 rounded-md border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs font-bold text-red-300 hover:bg-red-400/20 transition-all"
        >
          Reset Memory
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Wipe ALL memory?"
        description="Deletes every fact, person, relationship, ambiguity group, session, and message for every user. Users, projects, and admin login are preserved. This cannot be undone."
        confirmLabel="Wipe Memory"
        destructive
        onConfirm={() => void reset()}
        onCancel={() => setConfirmOpen(false)}
      />
      <ConfirmDialog
        open={!!resultMsg}
        title="Memory wiped"
        description={resultMsg ?? ''}
        confirmLabel="OK"
        hideCancel
        onConfirm={() => setResultMsg(null)}
        onCancel={() => setResultMsg(null)}
      />
    </div>
  );
};

// ── Developer panes ────────────────────────────────────────────

const LogsPane: React.FC = () => (
  <div className="space-y-4">
    <div className="flex items-center gap-2 border-b border-border/10 pb-4">
      <ScrollText className="text-primary w-5 h-5" />
      <h2 className="text-xl font-bold tracking-tight">Backend Logs</h2>
      <span className="text-[10px] font-bold text-muted-foreground bg-card/60 px-2 py-0.5 rounded-md border border-border/30 ml-2">
        LIVE · polls every 1.5s
      </span>
    </div>
    <p className="text-xs text-muted-foreground">In-memory ring buffer of the last 2000 backend log records (admin-only).</p>
    <LogViewer height="h-[60vh]" />
  </div>
);

const ToolsPane: React.FC = () => (
  <div className="space-y-4">
    <div className="flex items-center gap-2 border-b border-border/10 pb-4">
      <Wrench className="text-primary w-5 h-5" />
      <h2 className="text-xl font-bold tracking-tight">Tools</h2>
    </div>
    <div className="rounded-xl border border-border/30 bg-card/50 p-6 shadow-m1">
      <p className="text-sm text-muted-foreground">More developer tools coming soon.</p>
    </div>
  </div>
);
