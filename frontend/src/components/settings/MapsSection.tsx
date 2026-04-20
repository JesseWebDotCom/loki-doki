/**
 * MapsSection — admin panel for picking and installing offline map regions.
 *
 * Single-artifact flow: one checkbox per region selects the street
 * basemap + routing graph (built locally from the Geofabrik PBF).
 * Install opens a confirm modal; on confirm, PUTs fire for each
 * changed region and per-row progress chips stream phase + percent
 * over the SSE endpoint so the admin can see the multi-minute
 * tippecanoe / valhalla stages make progress.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HardDrive, AlertTriangle, Globe, Monitor, Moon, Sun } from "lucide-react";
import ConfirmDialog from "../ui/ConfirmDialog";
import { useMapTheme, type MapThemePreference } from "@/pages/maps/use-map-theme";
import {
  aggregateSize,
  changedRegions,
  estimateForPhase,
  flattenTree,
  formatMB,
  labelForPhase,
  type CatalogRegion,
  type SelectionMap,
} from "./MapsSection.helpers";

const API = "/api/v1/maps";

interface RegionStatus {
  region_id: string;
  label: string;
  config: { region_id: string; street: boolean } | null;
  state: {
    region_id: string;
    street_installed: boolean;
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

// Coarse platform hint for the time-estimate helper. The backend
// catalog doesn't currently surface the active profile here, so infer
// from the UA — m-series mac is the only meaningful "fast" bucket and
// everything else inherits the conservative Pi-5 timing.
function detectPlatform(): "mac" | "pi" | "unknown" {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac os") || ua.includes("macintosh")) return "mac";
  return "unknown";
}

function formatIndexRows(rows: number): string {
  if (rows < 1000) return `${rows} rows`;
  if (rows < 1_000_000) return `${(rows / 1000).toFixed(0)}k rows`;
  return `${(rows / 1_000_000).toFixed(1)}M rows`;
}

function clearProgressForRegion(
  regionId: string,
  setInstalling: React.Dispatch<React.SetStateAction<Set<string>>>,
  setProgress: React.Dispatch<React.SetStateAction<Record<string, InstallProgress>>>,
): void {
  setInstalling((prev) => {
    const next = new Set(prev);
    next.delete(regionId);
    return next;
  });
  setProgress((prev) => {
    if (!(regionId in prev)) return prev;
    const next = { ...prev };
    delete next[regionId];
    return next;
  });
}

function parseProgressProbe(body: string): InstallProgress | { status: string } | null {
  const line = body
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("data:"));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(5).trim()) as InstallProgress | { status: string };
  } catch {
    return null;
  }
}

const MapsSection: React.FC = () => {
  const { preference: mapTheme, setTheme: setMapTheme } = useMapTheme();
  const [tree, setTree] = useState<CatalogRegion[]>([]);
  const [installed, setInstalled] = useState<Record<string, RegionStatus>>({});
  const [selection, setSelection] = useState<SelectionMap>({});
  const [loading, setLoading] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({});
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const didProbeStaleProgress = useRef(false);

  const platform = useMemo(() => detectPlatform(), []);

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
        };
      }
      setInstalled(byId);
      setSelection(initial);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (loading || didProbeStaleProgress.current) return;
    didProbeStaleProgress.current = true;
    const staleIds = [
      ...new Set([...installing, ...Object.keys(progress)]),
    ].filter((regionId) => {
      const phase = progress[regionId]?.phase;
      return phase == null || phase !== "complete";
    });
    if (staleIds.length === 0) return;

    let cancelled = false;
    void (async () => {
      for (const regionId of staleIds) {
        try {
          const res = await fetch(`${API}/regions/${regionId}/progress`, {
            method: "GET",
            headers: authHeaders(),
          });
          const body = await res.text();
          const parsed = parseProgressProbe(body);
          if (cancelled || !parsed || !("status" in parsed) || parsed.status !== "idle") {
            continue;
          }
          clearProgressForRegion(regionId, setInstalling, setProgress);
          await reload();
        } catch {
          // Leave the optimistic UI state alone on transient probe failures.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [installing, loading, progress, reload]);

  const flat = useMemo(() => flattenTree(tree), [tree]);
  const downloadable = useMemo(() => flat.filter((r) => r.downloadable), [flat]);
  const totals = useMemo(() => aggregateSize(downloadable, selection), [downloadable, selection]);

  const toggle = (regionId: string) => {
    setSelection((prev) => {
      const current = prev[regionId] ?? { street: false };
      return { ...prev, [regionId]: { street: !current.street } };
    });
  };

  const clearAll = () => setSelection({});

  const selectNorthAmerica = () => {
    setSelection((prev) => {
      const next = { ...prev };
      for (const r of downloadable) {
        if (r.region_id === "us" || r.region_id.startsWith("us-") ||
            r.region_id === "ca" || r.region_id === "mx") {
          next[r.region_id] = { street: true };
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
                next[r.region_id] = { street: true };
              }
            }
          }
          if (kind === "region" && code === "us" && state) {
            const stateId = findUsStateId(downloadable, state);
            if (stateId) {
              next[stateId] = { street: true };
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
      before[id] = { street: Boolean(st.config?.street) };
    }
    return changedRegions(before, selection);
  }, [installed, selection]);

  const onInstallClick = () => {
    if (changed.length === 0) return;
    setConfirmOpen(true);
  };

  const runInstall = async () => {
    setConfirmOpen(false);
    setErrors({});
    const nextInstalling = new Set(installing);
    for (const regionId of changed) {
      const sel = selection[regionId] ?? { street: false };
      const res = await fetch(`${API}/regions/${regionId}`, {
        method: sel.street ? "PUT" : "DELETE",
        headers: authHeaders(),
        body: sel.street ? JSON.stringify(sel) : undefined,
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        setErrors((prev) => ({
          ...prev,
          [regionId]: `${res.status} ${res.statusText}${msg ? ` — ${msg}` : ""}`,
        }));
        continue;
      }
      if (sel.street) {
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
    const finishInstall = () => {
      clearProgressForRegion(regionId, setInstalling, setProgress);
      void reload();
    };
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
            finishInstall();
          }
        } else {
          es.close();
          finishInstall();
        }
      } catch {
        es.close();
        finishInstall();
      }
    };
    es.onerror = () => {
      es.close();
      if (!sawAnyEvent) {
        setErrors((prev) => ({
          ...prev,
          [regionId]: "progress stream disconnected before the install started",
        }));
      }
      finishInstall();
    };
  };

  if (loading) {
    return <div className="text-muted-foreground text-sm p-4">Loading…</div>;
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        Pick the regions you want usable offline. The first install downloads
        the OpenStreetMap extract for the region and then builds the vector
        tiles and routing graph on this device — no internet needed after.
      </p>

      <div className="rounded-xl border border-border/30 bg-card/40 p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">Map theme</p>
            <p className="text-xs text-muted-foreground">
              Follow your system appearance by default, or lock Maps to light or dark.
            </p>
          </div>
        </div>
        <div
          role="radiogroup"
          aria-label="Map theme"
          className="inline-flex flex-wrap gap-2"
        >
          <ThemeOption
            checked={mapTheme === "system"}
            icon={<Monitor size={13} />}
            label="Follow site theme"
            onSelect={() => setMapTheme("system")}
            value="system"
          />
          <ThemeOption
            checked={mapTheme === "light"}
            icon={<Sun size={13} />}
            label="Light"
            onSelect={() => setMapTheme("light")}
            value="light"
          />
          <ThemeOption
            checked={mapTheme === "dark"}
            icon={<Moon size={13} />}
            label="Dark"
            onSelect={() => setMapTheme("dark")}
            value="dark"
          />
        </div>
      </div>

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
              selection={selection[region.region_id]}
              onToggle={() => toggle(region.region_id)}
              progress={progress[region.region_id]}
              installing={installing.has(region.region_id)}
              error={errors[region.region_id]}
              onDismissError={() => clearRegionError(region.region_id)}
              platform={platform}
            />
          ))}
        </div>
      </div>

      {/* Running total + install */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/30 bg-card/40 p-3">
        <div className="flex items-center gap-2 text-xs">
          <HardDrive size={13} />
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
        description={`This will download ${formatMB(totals.total)} of source data across ${changed.length} region${changed.length === 1 ? "" : "s"}, then build tiles + routing on-device. Cancellable per-region once it starts.`}
        confirmLabel="Install"
        onConfirm={runInstall}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
};

// ── Subcomponents ────────────────────────────────────────────────

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

interface ThemeOptionProps {
  checked: boolean;
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
  value: MapThemePreference;
}

const ThemeOption: React.FC<ThemeOptionProps> = ({
  checked,
  icon,
  label,
  onSelect,
  value,
}) => (
  <label
    className={[
      "inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
      checked
        ? "border-primary/60 bg-primary/10 text-foreground"
        : "border-border/50 bg-card/50 text-muted-foreground hover:text-foreground",
    ].join(" ")}
  >
    <input
      checked={checked}
      className="sr-only"
      name="map-theme"
      onChange={onSelect}
      type="radio"
      value={value}
    />
    {icon}
    <span>{label}</span>
  </label>
);

interface RegionRowProps {
  region: CatalogRegion;
  depth: number;
  selection: { street: boolean } | undefined;
  onToggle: () => void;
  progress: InstallProgress | undefined;
  installing: boolean;
  error?: string;
  onDismissError: () => void;
  platform: "mac" | "pi" | "unknown";
}

const RegionRow: React.FC<RegionRowProps> = ({
  region, depth, selection, onToggle,
  progress, installing, error, onDismissError, platform,
}) => {
  const sel = selection ?? { street: false };
  const size = region.sizes_mb.street + region.sizes_mb.valhalla;
  const pct = progress && progress.bytes_total > 0
    ? Math.round((progress.bytes_done / progress.bytes_total) * 100)
    : null;
  const phaseLabel = progress ? labelForPhase(progress.phase) : null;
  const eta = progress
    ? estimateForPhase(progress.phase, region.sizes_mb.pbf, platform)
    : "";
  const detail = progress?.phase === "building_geocoder" && progress.bytes_done > 0
    ? formatIndexRows(progress.bytes_done)
    : "";

  return (
    <div
      className="flex flex-col gap-1 px-2 py-1.5 text-xs"
      style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={sel.street}
          disabled={!region.downloadable || installing}
          onChange={onToggle}
        />
        <span className="flex-1 truncate">{region.label}</span>
        {region.downloadable && (
          <span className="text-[10px] text-muted-foreground">{formatMB(size)}</span>
        )}
        {installing && !progress && (
          <span className="text-[10px] text-muted-foreground">starting…</span>
        )}
        {progress && phaseLabel && (
          <span className="text-[10px] text-primary">
            {phaseLabel}{pct !== null ? ` · ${pct}%` : ""}
          </span>
        )}
      </div>
      {eta && (
        <div
          className="text-[10px] text-muted-foreground"
          style={{ paddingLeft: "1.5rem" }}
        >
          {eta}
        </div>
      )}
      {detail && (
        <div
          className="text-[10px] text-muted-foreground"
          style={{ paddingLeft: "1.5rem" }}
        >
          {detail}
        </div>
      )}
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
