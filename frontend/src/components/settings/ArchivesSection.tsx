/**
 * ArchivesSection — admin panel for managing offline knowledge archives.
 *
 * Layout: category-grouped grid of "hero" cards. Each card has a
 * colored top region with the archive's favicon + a body containing
 * the category tag, title, and description. Click → detail modal.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Trash2, HardDrive, AlertTriangle,
} from 'lucide-react';

const API = '/api/v1/archives';

// ── Types ──────────────────────────────────────────────────────

interface ZimVariant {
  key: string;
  label: string;
  approx_size_gb: number;
  url_slug: string;
}

interface CatalogEntry {
  source_id: string;
  label: string;
  description: string;
  category: string;
  favicon_exists: boolean;
  variants: ZimVariant[];
  default_variant: string;
  is_topic_picker: boolean;
}

interface ArchiveConfig {
  source_id: string;
  enabled: boolean;
  variant: string;
  language: string;
  storage_path: string | null;
  topics: string[];
}

interface ArchiveState {
  source_id: string;
  file_size_bytes: number;
  zim_date: string;
  download_complete: boolean;
  downloaded_at: string | null;
}

interface ArchiveStatus {
  source_id: string;
  label: string;
  description: string;
  category: string;
  config: ArchiveConfig | null;
  state: ArchiveState | null;
}

interface StorageInfo {
  total_used_bytes: number;
  pending_download_bytes: number;
  default_location: { path: string; total_bytes: number; free_bytes: number };
  projected_free_bytes: number;
  low_space_warning: boolean;
}

interface DownloadProgress {
  source_id: string;
  status: string;
  bytes_downloaded: number;
  bytes_total: number;
  percent: number;
  speed_bps: number;
  error: string | null;
}

// ── Helpers ────────────────────────────────────────────────────

const fmt = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
};

const fmtSpeed = (bps: number): string => {
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
};

const authHeaders = (): HeadersInit => {
  const token = localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
};

/**
 * Map each category to a tinted header background. Stays within the
 * Onyx Material palette — not brand colors — so the carousel feels
 * consistent with the rest of the app.
 */
const CATEGORY_BG: Record<string, string> = {
  Knowledge:   'bg-blue-500/15 dark:bg-blue-400/15',
  Maintenance: 'bg-sky-500/15 dark:bg-sky-400/15',
  Medical:     'bg-rose-500/15 dark:bg-rose-400/15',
  Survival:    'bg-amber-500/15 dark:bg-amber-400/15',
  Education:   'bg-violet-500/15 dark:bg-violet-400/15',
  Reference:   'bg-slate-500/15 dark:bg-slate-400/15',
  Inspiration: 'bg-emerald-500/15 dark:bg-emerald-400/15',
  Navigation:  'bg-teal-500/15 dark:bg-teal-400/15',
};

const categoryBg = (category: string): string =>
  CATEGORY_BG[category] ?? 'bg-primary/10';

// Display order of categories in the carousel.
const CATEGORY_ORDER = [
  'Knowledge', 'Maintenance', 'Medical', 'Survival',
  'Education', 'Navigation', 'Reference', 'Inspiration',
];

// ── Component ──────────────────────────────────────────────────

const ArchivesSection: React.FC = () => {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [statuses, setStatuses] = useState<ArchiveStatus[]>([]);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({});
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const parse = async (path: string): Promise<object | null> => {
      try {
        const res = await fetch(`${API}${path}`, { headers: authHeaders() });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    };
    try {
      const [catRes, statusRes, storageRes] = await Promise.all([
        parse('/catalog'),
        parse('/status'),
        parse('/storage'),
      ]);
      setCatalog(((catRes as { catalog?: CatalogEntry[] } | null)?.catalog) ?? []);
      setStatuses(((statusRes as { archives?: ArchiveStatus[] } | null)?.archives) ?? []);
      // Only keep a storage object if it actually has the expected
      // shape — a 401 body would otherwise render as {detail:"..."} and
      // blow up the render tree on ``storage.default_location.free_bytes``.
      const s = storageRes as StorageInfo | null;
      if (s && s.default_location && typeof s.default_location === 'object') {
        setStorage(s);
      } else {
        setStorage(null);
      }
    } catch (e) {
      console.error('Failed to load archive data', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Poll active downloads
  useEffect(() => {
    const active = Object.keys(downloads).filter(k => ['resolving', 'downloading'].includes(downloads[k].status));
    if (active.length === 0) return;
    const interval = setInterval(async () => {
      for (const sourceId of active) {
        try {
          const res = await fetch(`${API}/${sourceId}/progress`, { headers: authHeaders() });
          const progress: DownloadProgress = await res.json();
          setDownloads(prev => ({ ...prev, [sourceId]: progress }));
          if (progress.status === 'complete' || progress.status === 'error') {
            reload();
          }
        } catch { /* ignore */ }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [downloads, reload]);

  const statusMap = useMemo(() => {
    const m: Record<string, ArchiveStatus> = {};
    statuses.forEach(s => { m[s.source_id] = s; });
    return m;
  }, [statuses]);

  // Bucket catalog by category, preserving CATEGORY_ORDER. Categories
  // with no entries are skipped so the admin doesn't see empty headers.
  const grouped = useMemo(() => {
    const buckets: Record<string, CatalogEntry[]> = {};
    for (const entry of catalog) {
      (buckets[entry.category] ||= []).push(entry);
    }
    return CATEGORY_ORDER
      .map(category => ({ category, entries: buckets[category] || [] }))
      .filter(g => g.entries.length > 0);
  }, [catalog]);

  // ── Handlers ─────────────────────────────────────────────────

  const handleToggle = async (sourceId: string, entry: CatalogEntry) => {
    const status = statusMap[sourceId];
    const isInstalled = status?.state?.download_complete ?? false;
    // Mirror the card's view: downloaded + no config counts as on.
    const isCurrentlyEnabled = status?.config?.enabled ?? isInstalled;

    if (isCurrentlyEnabled) {
      await fetch(`${API}/${sourceId}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({ variant: status?.config?.variant || entry.default_variant, enabled: false }),
      });
      reload();
    } else {
      const variant = status?.config?.variant || entry.default_variant;
      await fetch(`${API}/${sourceId}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({ variant, enabled: true }),
      });
      if (!isInstalled) {
        const res = await fetch(`${API}/${sourceId}/download`, { method: 'POST', headers: authHeaders() });
        if (res.ok) {
          setDownloads(prev => ({
            ...prev,
            [sourceId]: { source_id: sourceId, status: 'resolving', bytes_downloaded: 0, bytes_total: 0, percent: 0, speed_bps: 0, error: null },
          }));
        }
      }
      reload();
    }
  };

  const handleCancel = async (sourceId: string) => {
    await fetch(`${API}/${sourceId}/cancel`, { method: 'POST', headers: authHeaders() });
    await fetch(`${API}/${sourceId}`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    setDownloads(prev => { const next = { ...prev }; delete next[sourceId]; return next; });
    reload();
  };

  const handleRemove = async (sourceId: string) => {
    await fetch(`${API}/${sourceId}`, { method: 'DELETE', headers: authHeaders() });
    setSelectedId(null);
    reload();
  };

  const handleVariantChange = async (sourceId: string, variant: string) => {
    const status = statusMap[sourceId];
    await fetch(`${API}/${sourceId}`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ variant, enabled: status?.config?.enabled ?? false }),
    });
    reload();
  };

  // ── Render ───────────────────────────────────────────────────

  if (loading) {
    return <div className="text-muted-foreground text-sm p-4">Loading…</div>;
  }

  const selected = selectedId ? catalog.find(e => e.source_id === selectedId) : null;
  const selectedStatus = selectedId ? statusMap[selectedId] : null;
  const selectedDl = selectedId ? downloads[selectedId] : null;

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        Toggle an archive on to download and enable it for search and chat.
        Toggle off to disable without deleting.
      </p>

      {/* Storage bar */}
      {storage && (
        <div className="rounded-xl border border-border/30 bg-card/40 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <HardDrive size={13} />
            <span>Used: <strong className="text-foreground">{fmt(storage.total_used_bytes)}</strong></span>
            <span>·</span>
            <span>Free: <strong className="text-foreground">{fmt(storage.default_location.free_bytes)}</strong></span>
          </div>
          {storage.low_space_warning && (
            <div className="flex items-center gap-1.5 text-[10px] text-destructive">
              <AlertTriangle size={11} /> Less than 2 GB would remain after pending downloads
            </div>
          )}
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${Math.min((storage.total_used_bytes / storage.default_location.total_bytes) * 100, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Category-grouped tile grid */}
      <div className="space-y-8">
        {grouped.map(({ category, entries }) => (
          <section key={category} className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                {category}
              </h3>
              <span className="text-[10px] text-muted-foreground/60">{entries.length}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
              {entries.map(entry => (
                <ArchiveCard
                  key={entry.source_id}
                  entry={entry}
                  status={statusMap[entry.source_id]}
                  dl={downloads[entry.source_id]}
                  onClick={() => setSelectedId(entry.source_id)}
                  onToggle={() => handleToggle(entry.source_id, entry)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Detail panel (opens when a tile is clicked) */}
      {selected && selectedStatus && (
        <ArchiveDetailPanel
          entry={selected}
          status={selectedStatus}
          dl={selectedDl ?? undefined}
          onToggle={() => handleToggle(selected.source_id, selected)}
          onVariantChange={(v) => handleVariantChange(selected.source_id, v)}
          onCancel={() => handleCancel(selected.source_id)}
          onRemove={() => handleRemove(selected.source_id)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
};

// ── Single hero card ───────────────────────────────────────────

interface CardProps {
  entry: CatalogEntry;
  status?: ArchiveStatus;
  dl?: DownloadProgress;
  onClick: () => void;
  onToggle: () => void;
}

const ArchiveCard: React.FC<CardProps> = ({ entry, status, dl, onClick, onToggle }) => {
  // Downloaded-but-no-config counts as enabled — prevents the "file is
  // on disk but toggle shows off" orphan state that confused users
  // when a download completed before a config row existed.
  const isInstalled = status?.state?.download_complete ?? false;
  const isEnabled = status?.config?.enabled ?? isInstalled;
  const isDownloading = dl && ['resolving', 'downloading'].includes(dl.status);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
      className="group relative flex flex-col overflow-hidden rounded-2xl border border-border/30 bg-card shadow-sm hover:border-primary/40 hover:shadow-md transition-all cursor-pointer"
    >
      {/* Hero area with favicon */}
      <div
        className={`relative flex h-40 items-center justify-center ${categoryBg(entry.category)}`}
      >
        <img
          src={`${API}/favicon/${entry.source_id}`}
          alt=""
          className="h-20 w-20 object-contain"
          onError={e => {
            const el = e.target as HTMLImageElement;
            el.style.display = 'none';
            el.parentElement!.innerHTML += `<span class="text-5xl font-black text-foreground/50">${entry.label[0]}</span>`;
          }}
        />

        {/* Toggle in top-right */}
        <div className="absolute top-3 right-3" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => !isDownloading && onToggle()}
            disabled={!!isDownloading}
            className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full border-2 transition-colors duration-200 focus:outline-none ${
              (isEnabled || isDownloading)
                ? 'bg-primary border-primary'
                : 'bg-card border-border'
            } ${isDownloading ? 'opacity-60 cursor-wait' : ''}`}
            title={isEnabled ? 'Disable' : 'Enable (downloads if needed)'}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ${
                (isEnabled || isDownloading) ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Download progress ribbon */}
        {isDownloading && dl && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${dl.percent}%` }} />
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-2 p-5">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
          {entry.category}
        </span>
        <h3 className="text-lg font-bold tracking-tight leading-tight">
          {entry.label}
        </h3>
        <p className="text-sm text-muted-foreground leading-snug line-clamp-4">
          {entry.description}
        </p>
      </div>
    </div>
  );
};

// ── Detail panel ───────────────────────────────────────────────

interface DetailProps {
  entry: CatalogEntry;
  status: ArchiveStatus;
  dl?: DownloadProgress;
  onToggle: () => void;
  onVariantChange: (variant: string) => void;
  onCancel: () => void;
  onRemove: () => void;
  onClose: () => void;
}

const ArchiveDetailPanel: React.FC<DetailProps> = ({
  entry, status, dl, onToggle, onVariantChange, onCancel, onRemove, onClose,
}) => {
  const config = status.config;
  const state = status.state;
  const isEnabled = config?.enabled ?? false;
  const isInstalled = state?.download_complete ?? false;
  const isDownloading = dl && ['resolving', 'downloading'].includes(dl.status);
  const selectedVariant = config?.variant || entry.default_variant;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-2xl shadow-m4 w-full max-w-lg mx-4 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header with hero */}
        <div className={`relative flex h-32 items-center justify-center ${categoryBg(entry.category)}`}>
          <img
            src={`${API}/favicon/${entry.source_id}`}
            alt=""
            className="h-16 w-16 object-contain"
            onError={e => {
              const el = e.target as HTMLImageElement;
              el.style.display = 'none';
            }}
          />
          <button
            onClick={onToggle}
            disabled={!!isDownloading}
            className={`absolute top-4 right-4 relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 transition-colors duration-200 focus:outline-none ${
              (isEnabled || isDownloading) ? 'bg-primary border-primary' : 'bg-card border-border'
            } ${isDownloading ? 'opacity-60 cursor-wait' : ''}`}
            title={isEnabled ? 'Disable' : isInstalled ? 'Enable' : 'Download & enable'}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ${
                (isEnabled || isDownloading) ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
              {entry.category}
            </span>
            <h3 className="text-xl font-bold tracking-tight">{entry.label}</h3>
            <p className="text-sm text-muted-foreground">{entry.description}</p>
          </div>

          {/* Variant selector */}
          {entry.variants.length > 1 && (
            <div className="space-y-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Archive Level</div>
              <div className="flex flex-wrap gap-2">
                {entry.variants.map(v => (
                  <button
                    key={v.key}
                    onClick={() => onVariantChange(v.key)}
                    className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                      v.key === selectedVariant
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border/50 bg-card/30 text-muted-foreground hover:border-primary/50'
                    }`}
                  >
                    {v.label} <span className="opacity-60">~{v.approx_size_gb} GB</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Download progress */}
          {isDownloading && dl && (
            <div className="space-y-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Downloading</div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${dl.percent}%` }} />
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>{fmt(dl.bytes_downloaded)} / {fmt(dl.bytes_total)}</span>
                <span>{fmtSpeed(dl.speed_bps)}</span>
              </div>
              <button
                onClick={onCancel}
                className="text-xs text-destructive hover:underline"
              >
                Cancel download
              </button>
            </div>
          )}

          {/* Installed state */}
          {isInstalled && state && !isDownloading && (
            <div className="space-y-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Installed</div>
              <div className="text-xs text-muted-foreground">
                {fmt(state.file_size_bytes)} · Synced {state.zim_date}
                {state.downloaded_at && ` · Downloaded ${new Date(state.downloaded_at).toLocaleDateString()}`}
              </div>
            </div>
          )}

          {/* Not installed */}
          {!isInstalled && !isDownloading && (
            <div className="text-xs text-muted-foreground italic">
              Not downloaded. Toggle on to start downloading.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border/20 flex items-center justify-between">
          <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Close
          </button>
          {isInstalled && (
            <button
              onClick={onRemove}
              className="inline-flex items-center gap-1 text-xs text-destructive/60 hover:text-destructive transition-colors"
            >
              <Trash2 size={11} /> Delete archive
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ArchivesSection;
