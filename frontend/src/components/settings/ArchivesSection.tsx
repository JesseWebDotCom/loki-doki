/**
 * ArchivesSection — admin panel for managing offline knowledge archives.
 *
 * Uses a tile grid layout matching the Skills section. Each tile shows
 * the archive favicon, name, size, and a status dot. Toggle ON starts
 * download + enables. Toggle OFF disables (keeps file). Remove deletes.
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

const CATEGORIES = ['General', 'Reference', 'Practical', 'Education', 'Emergency'];

// ── Component ──────────────────────────────────────────────────

const ArchivesSection: React.FC = () => {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [statuses, setStatuses] = useState<ArchiveStatus[]>([]);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({});
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [catRes, statusRes, storageRes] = await Promise.all([
        fetch(`${API}/catalog`, { headers: authHeaders() }).then(r => r.json()),
        fetch(`${API}/status`, { headers: authHeaders() }).then(r => r.json()),
        fetch(`${API}/storage`, { headers: authHeaders() }).then(r => r.json()),
      ]);
      setCatalog(catRes.catalog || []);
      setStatuses(statusRes.archives || []);
      setStorage(storageRes);
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

  // ── Handlers ─────────────────────────────────────────────────

  /** Toggle ON = configure + download if needed. Toggle OFF = disable. */
  const handleToggle = async (sourceId: string, entry: CatalogEntry) => {
    const status = statusMap[sourceId];
    const isCurrentlyEnabled = status?.config?.enabled ?? false;
    const isInstalled = status?.state?.download_complete ?? false;

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

  const grouped = CATEGORIES.map(cat => ({
    category: cat,
    entries: catalog.filter(e => e.category === cat),
  })).filter(g => g.entries.length > 0);

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

      {/* Tile grid by category */}
      <div className="space-y-6">
        {grouped.map(({ category, entries }) => (
          <section key={category} className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                {category}
              </h3>
              <span className="text-[10px] text-muted-foreground/60">{entries.length}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {entries.map(entry => {
                const status = statusMap[entry.source_id];
                const dl = downloads[entry.source_id];
                const isDownloading = dl && ['resolving', 'downloading'].includes(dl.status);
                const variant = entry.variants.find(v => v.key === (status?.config?.variant || entry.default_variant)) || entry.variants[0];

                const isEnabled = status?.config?.enabled ?? false;

                return (
                  <div
                    key={entry.source_id}
                    className="group relative flex flex-col items-start gap-2 p-4 rounded-2xl border border-border/30 bg-card/40 hover:bg-card/70 hover:border-primary/40 transition-all text-left h-full"
                  >
                    {/* Toggle switch — top right */}
                    <div
                      className="absolute top-3 right-3"
                      onClick={e => e.stopPropagation()}
                    >
                      <button
                        onClick={() => !isDownloading && handleToggle(entry.source_id, entry)}
                        disabled={!!isDownloading}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 transition-colors duration-200 focus:outline-none ${
                          (isEnabled || isDownloading)
                            ? 'bg-primary border-primary'
                            : 'bg-muted-foreground/30 border-muted-foreground/30'
                        } ${isDownloading ? 'opacity-60 cursor-wait' : ''}`}
                        title={isEnabled ? 'Disable' : 'Enable (downloads if needed)'}
                      >
                        <span
                          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ${
                            (isEnabled || isDownloading) ? 'translate-x-4' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>

                    {/* Clickable body → opens detail */}
                    <button
                      type="button"
                      onClick={() => setSelectedId(entry.source_id)}
                      className="flex flex-col items-start gap-2 w-full text-left cursor-pointer"
                    >
                      {/* Favicon */}
                      <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 text-primary group-hover:bg-primary/20 transition-colors overflow-hidden">
                        <img
                          src={`${API}/favicon/${entry.source_id}`}
                          alt=""
                          className="w-6 h-6"
                          onError={e => {
                            const el = e.target as HTMLImageElement;
                            el.style.display = 'none';
                            el.parentElement!.innerHTML = `<span class="text-lg font-bold">${entry.label[0]}</span>`;
                          }}
                        />
                      </div>
                      <h3 className="text-sm font-bold tracking-tight truncate w-full">
                        {entry.label}
                      </h3>
                      <p className="text-[11px] text-muted-foreground line-clamp-2 leading-snug">
                        {entry.description}
                      </p>
                      <span className="text-[10px] text-muted-foreground/60 mt-auto">
                        ~{variant.approx_size_gb} GB
                      </span>
                    </button>

                    {/* Download progress overlay */}
                    {isDownloading && dl && (
                      <div className="absolute bottom-0 left-0 right-0 h-1 rounded-b-2xl bg-muted overflow-hidden">
                        <div className="h-full bg-primary transition-all" style={{ width: `${dl.percent}%` }} />
                      </div>
                    )}
                  </div>
                );
              })}
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
        {/* Header */}
        <div className="p-6 border-b border-border/20">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center overflow-hidden">
                <img
                  src={`${API}/favicon/${entry.source_id}`}
                  alt=""
                  className="w-7 h-7"
                  onError={e => {
                    const el = e.target as HTMLImageElement;
                    el.style.display = 'none';
                    el.parentElement!.innerHTML = `<span class="text-xl font-bold text-primary">${entry.label[0]}</span>`;
                  }}
                />
              </div>
              <div>
                <h3 className="text-lg font-bold tracking-tight">{entry.label}</h3>
                <p className="text-xs text-muted-foreground">{entry.description}</p>
              </div>
            </div>

            {/* Toggle switch */}
            <button
              onClick={onToggle}
              disabled={!!isDownloading}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 transition-colors duration-200 focus:outline-none mt-1 ${
                (isEnabled || isDownloading) ? 'bg-primary border-primary' : 'bg-muted-foreground/30 border-muted-foreground/30'
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
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
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
