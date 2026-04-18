/**
 * MapsSection — admin panel for picking and installing offline map regions.
 *
 * Two tabs: Street maps, Satellite imagery. Each tab shows the region
 * tree with per-row checkboxes. The running-total pill at the bottom
 * updates live. Install opens a confirm modal; on confirm, PUTs fire
 * for each changed region and a single horizontal progress bar tracks
 * bytes downloaded across the combined plan.
 *
 * Satellite requires street — enforced both here and at the API.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { HardDrive, AlertTriangle, MapPin, Globe, Image as ImageIcon } from "lucide-react";
import ConfirmDialog from "../ui/ConfirmDialog";
import {
  aggregateSize,
  changedRegions,
  flattenTree,
  formatMB,
  validateSelection,
  type CatalogRegion,
  type SelectionMap,
} from "./MapsSection.helpers";

const API = "/api/v1/maps";

interface RegionStatus {
  region_id: string;
  label: string;
  config: { region_id: string; street: boolean; satellite: boolean } | null;
  state: {
    region_id: string;
    street_installed: boolean;
    satellite_installed: boolean;
    valhalla_installed: boolean;
    bytes_on_disk: Record<string, number>;
  };
}

interface InstallProgress {
  region_id: string;
  artifact: string;
  bytes_done: number;
  bytes_total: number;
  phase: string;
  error: string | null;
}

const authHeaders = (): HeadersInit => {
  const token = localStorage.getItem("auth_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
};

type Tab = "street" | "satellite";

const MapsSection: React.FC = () => {
  const [tree, setTree] = useState<CatalogRegion[]>([]);
  const [installed, setInstalled] = useState<Record<string, RegionStatus>>({});
  const [selection, setSelection] = useState<SelectionMap>({});
  const [tab, setTab] = useState<Tab>("street");
  const [loading, setLoading] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({});
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    try {
      const [catRes, regionsRes] = await Promise.all([
        fetch(`${API}/catalog`, { headers: authHeaders() }).then((r) => r.json()),
        fetch(`${API}/regions`, { headers: authHeaders() }).then((r) => r.json()),
      ]);
      setTree(catRes?.regions ?? []);
      const byId: Record<string, RegionStatus> = {};
      const initial: SelectionMap = {};
      for (const row of regionsRes as RegionStatus[]) {
        byId[row.region_id] = row;
        initial[row.region_id] = {
          street: Boolean(row.config?.street ?? row.state?.street_installed),
          satellite: Boolean(row.config?.satellite ?? row.state?.satellite_installed),
        };
      }
      setInstalled(byId);
      setSelection(initial);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const flat = useMemo(() => flattenTree(tree), [tree]);
  const downloadable = useMemo(() => flat.filter((r) => r.downloadable), [flat]);
  const totals = useMemo(() => aggregateSize(downloadable, selection), [downloadable, selection]);

  const toggle = (regionId: string, field: keyof SelectionMap[string]) => {
    setSelection((prev) => {
      const current = prev[regionId] ?? { street: false, satellite: false };
      const next = { ...current, [field]: !current[field] };
      // If street is off, satellite must be off too.
      if (field === "street" && !next.street) next.satellite = false;
      return { ...prev, [regionId]: next };
    });
  };

  const clearAll = () => setSelection({});

  const selectNorthAmerica = () => {
    setSelection((prev) => {
      const next = { ...prev };
      for (const r of downloadable) {
        if (r.region_id === "us" || r.region_id.startsWith("us-") ||
            r.region_id === "ca" || r.region_id === "mx") {
          next[r.region_id] = { ...(next[r.region_id] ?? { satellite: false }), street: true };
        }
      }
      return next;
    });
  };

  const geoPreset = async (kind: "region" | "country") => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`;
        const res = await fetch(url, { headers: { "User-Agent": "LokiDoki" } });
        const body = await res.json();
        const code = (body?.address?.country_code || "").toLowerCase();
        const state = (body?.address?.state || "").toLowerCase();
        setSelection((prev) => {
          const next = { ...prev };
          if (kind === "country" && code) {
            for (const r of downloadable) {
              if (r.region_id === code) {
                next[r.region_id] = { ...(next[r.region_id] ?? { satellite: false }), street: true };
              }
            }
          }
          if (kind === "region" && code === "us" && state) {
            const stateId = findUsStateId(downloadable, state);
            if (stateId) {
              next[stateId] = { ...(next[stateId] ?? { satellite: false }), street: true };
            }
          }
          return next;
        });
      } catch { /* offline: leave selection as-is */ }
    });
  };

  const changed = useMemo(() => {
    const before: SelectionMap = {};
    for (const [id, st] of Object.entries(installed)) {
      before[id] = {
        street: Boolean(st.config?.street),
        satellite: Boolean(st.config?.satellite),
      };
    }
    return changedRegions(before, selection);
  }, [installed, selection]);

  const onInstallClick = () => {
    const bad = validateSelection(selection);
    if (bad !== null) return;
    if (changed.length === 0) return;
    setConfirmOpen(true);
  };

  const runInstall = async () => {
    setConfirmOpen(false);
    setErrors({});
    const nextInstalling = new Set(installing);
    for (const regionId of changed) {
      const sel = selection[regionId] ?? { street: false, satellite: false };
      const res = await fetch(`${API}/regions/${regionId}`, {
        method: sel.street || sel.satellite ? "PUT" : "DELETE",
        headers: authHeaders(),
        body: sel.street || sel.satellite ? JSON.stringify(sel) : undefined,
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        setErrors((prev) => ({
          ...prev,
          [regionId]: `${res.status} ${res.statusText}${msg ? ` — ${msg}` : ""}`,
        }));
        continue;
      }
      if (sel.street || sel.satellite) {
        nextInstalling.add(regionId);
        streamProgress(regionId);
      }
    }
    setInstalling(nextInstalling);
  };

  const clearRegionError = (regionId: string) => {
    setErrors((prev) => {
      if (!(regionId in prev)) return prev;
      const next = { ...prev };
      delete next[regionId];
      return next;
    });
  };

  const streamProgress = (regionId: string) => {
    const es = new EventSource(`${API}/regions/${regionId}/progress`);
    let sawAnyEvent = false;
    es.onmessage = (ev) => {
      sawAnyEvent = true;
      try {
        const p = JSON.parse(ev.data) as InstallProgress | { status: string };
        if ("bytes_done" in p) {
          setProgress((prev) => ({ ...prev, [regionId]: p }));
          if (p.error) {
            setErrors((prev) => ({ ...prev, [regionId]: p.error ?? "install failed" }));
          }
          if (p.phase === "complete" && (p.artifact === "done" || p.error)) {
            es.close();
            setInstalling((prev) => {
              const next = new Set(prev);
              next.delete(regionId);
              return next;
            });
            void reload();
          }
        } else {
          es.close();
        }
      } catch {
        es.close();
      }
    };
    es.onerror = () => {
      es.close();
      setInstalling((prev) => {
        const next = new Set(prev);
        next.delete(regionId);
        return next;
      });
      if (!sawAnyEvent) {
        setErrors((prev) => ({
          ...prev,
          [regionId]: "progress stream disconnected before the install started",
        }));
      }
    };
  };

  if (loading) {
    return <div className="text-muted-foreground text-sm p-4">Loading…</div>;
  }

  const showSatellite = tab === "satellite";

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        Pick the regions you want usable offline. Maps work without the internet
        once their region artifacts are installed.
      </p>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-border/40">
        <TabButton active={tab === "street"} onClick={() => setTab("street")}
                   icon={<MapPin size={14} />} label="Street maps" />
        <TabButton active={tab === "satellite"} onClick={() => setTab("satellite")}
                   icon={<ImageIcon size={14} />} label="Satellite imagery" />
      </div>

      {showSatellite && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-100">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <p>
            <strong>Satellite imagery is 10–20× larger than street maps.</strong>{" "}
            Pick only the regions you actually need photography for. A state's
            satellite bundle can exceed 40&nbsp;GB.
          </p>
        </div>
      )}

      {/* Presets */}
      <div className="flex flex-wrap gap-2">
        <PresetButton onClick={() => geoPreset("region")}     label="My region" />
        <PresetButton onClick={() => geoPreset("country")}   label="My country" />
        <PresetButton onClick={selectNorthAmerica}            label="North America" />
        <PresetButton onClick={clearAll}                      label="Clear all" />
      </div>

      {/* Region tree */}
      <div className="rounded-xl border border-border/30 bg-card/40 p-2">
        <div className="max-h-[420px] overflow-y-auto divide-y divide-border/20">
          {flat.map((region) => (
            <RegionRow
              key={region.region_id}
              region={region}
              depth={depthOf(region, flat)}
              tab={tab}
              selection={selection[region.region_id]}
              onToggleStreet={() => toggle(region.region_id, "street")}
              onToggleSatellite={() => toggle(region.region_id, "satellite")}
              progress={progress[region.region_id]}
              installing={installing.has(region.region_id)}
              error={errors[region.region_id]}
              onDismissError={() => clearRegionError(region.region_id)}
            />
          ))}
        </div>
      </div>

      {/* Running total + install */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/30 bg-card/40 p-3">
        <div className="flex items-center gap-2 text-xs">
          <HardDrive size={13} />
          <span>Street: <strong>{formatMB(totals.street)}</strong></span>
          <span className="text-muted-foreground">·</span>
          <span>Satellite: <strong>{formatMB(totals.satellite)}</strong></span>
          <span className="text-muted-foreground">·</span>
          <span>Total: <strong>{formatMB(totals.total)}</strong></span>
        </div>
        <button
          disabled={changed.length === 0 || installing.size > 0}
          onClick={onInstallClick}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {installing.size > 0 ? "Installing…" : `Install ${changed.length || ""} change${changed.length === 1 ? "" : "s"}`.trim()}
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Install selected regions"
        description={`This will download ${formatMB(totals.total)} across ${changed.length} region${changed.length === 1 ? "" : "s"}. The download can be cancelled per-region once it starts.`}
        confirmLabel="Install"
        onConfirm={runInstall}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
};

// ── Subcomponents ────────────────────────────────────────────────

const TabButton: React.FC<{ active: boolean; onClick: () => void; icon: React.ReactNode; label: string }>
    = ({ active, onClick, icon, label }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-1.5 px-3 py-2 text-xs border-b-2 transition-colors ${
      active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
    }`}
  >
    {icon}
    {label}
  </button>
);

const PresetButton: React.FC<{ onClick: () => void; label: string }>
    = ({ onClick, label }) => (
  <button
    onClick={onClick}
    className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-card/40 px-3 py-1 text-[11px] hover:border-primary/40"
  >
    <Globe size={11} />
    {label}
  </button>
);

interface RegionRowProps {
  region: CatalogRegion;
  depth: number;
  tab: Tab;
  selection: { street: boolean; satellite: boolean } | undefined;
  onToggleStreet: () => void;
  onToggleSatellite: () => void;
  progress: InstallProgress | undefined;
  installing: boolean;
  error?: string;
  onDismissError: () => void;
}

const RegionRow: React.FC<RegionRowProps> = ({
  region, depth, tab, selection, onToggleStreet, onToggleSatellite,
  progress, installing, error, onDismissError,
}) => {
  const sel = selection ?? { street: false, satellite: false };
  const satDisabled = tab === "satellite" && !sel.street;
  const onSelect = tab === "street" ? onToggleStreet : onToggleSatellite;
  const checked = tab === "street" ? sel.street : sel.satellite;
  const size = tab === "street"
    ? region.sizes_mb.street + region.sizes_mb.valhalla
    : region.sizes_mb.satellite;

  return (
    <div
      className={`flex flex-col gap-1 px-2 py-1.5 text-xs ${
        satDisabled ? "opacity-40" : ""
      }`}
      style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          disabled={!region.downloadable || satDisabled || installing}
          onChange={onSelect}
        />
        <span className="flex-1 truncate">{region.label}</span>
        {region.downloadable && (
          <span className="text-[10px] text-muted-foreground">{formatMB(size)}</span>
        )}
        {installing && !progress && (
          <span className="text-[10px] text-muted-foreground">starting…</span>
        )}
        {progress && progress.bytes_total > 0 && (
          <span className="text-[10px] text-primary">
            {Math.round((progress.bytes_done / progress.bytes_total) * 100)}%
          </span>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive-foreground"
        >
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={onDismissError}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
};

// ── Helpers ──────────────────────────────────────────────────────

function depthOf(region: CatalogRegion, flat: CatalogRegion[]): number {
  let depth = 0;
  let parentId: string | null = region.parent_id;
  const byId = new Map(flat.map((r) => [r.region_id, r]));
  while (parentId) {
    depth += 1;
    const parent = byId.get(parentId);
    parentId = parent?.parent_id ?? null;
    if (depth > 6) break;
  }
  return depth;
}

function findUsStateId(regions: CatalogRegion[], stateName: string): string | null {
  const needle = stateName.toLowerCase();
  const r = regions.find(
    (x) => x.parent_id === "us" && x.label.toLowerCase() === needle,
  );
  return r?.region_id ?? null;
}

export default MapsSection;
