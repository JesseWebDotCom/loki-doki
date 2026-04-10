import { useEffect, useSyncExternalStore } from 'react';

export type ConnectivityStatus = 'online' | 'browser_offline' | 'backend_offline';

export interface ConnectivitySnapshot {
  browserOnline: boolean;
  backendReachable: boolean;
  status: ConnectivityStatus;
}

type ConnectivityState = {
  browserOnline: boolean;
  backendReachable: boolean;
};

const listeners = new Set<() => void>();

const initialBrowserOnline =
  typeof navigator === 'undefined' ? true : navigator.onLine;

let state: ConnectivityState = {
  browserOnline: initialBrowserOnline,
  backendReachable: true,
};
let snapshot: ConnectivitySnapshot = deriveSnapshot(state);

let monitoringStarted = false;

function deriveSnapshot(nextState: ConnectivityState): ConnectivitySnapshot {
  if (!nextState.backendReachable) {
    return { ...nextState, status: 'backend_offline' };
  }
  if (!nextState.browserOnline) {
    return { ...nextState, status: 'browser_offline' };
  }
  return { ...nextState, status: 'online' };
}

function emit(): void {
  for (const listener of listeners) listener();
}

function updateState(partial: Partial<ConnectivityState>): void {
  const nextState = { ...state, ...partial };
  if (
    nextState.browserOnline === state.browserOnline &&
    nextState.backendReachable === state.backendReachable
  ) {
    return;
  }
  state = nextState;
  snapshot = deriveSnapshot(state);
  emit();
}

function handleBrowserOnline(): void {
  updateState({ browserOnline: true });
}

function handleBrowserOffline(): void {
  updateState({ browserOnline: false });
}

export function startConnectivityMonitor(): void {
  if (monitoringStarted || typeof window === 'undefined') return;
  monitoringStarted = true;
  window.addEventListener('online', handleBrowserOnline);
  window.addEventListener('offline', handleBrowserOffline);
}

export function getConnectivitySnapshot(): ConnectivitySnapshot {
  return snapshot;
}

export function subscribeToConnectivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function markBackendReachable(): void {
  updateState({ backendReachable: true });
}

export function markBackendOffline(): void {
  updateState({ backendReachable: false });
}

export function useConnectivityStatus(): ConnectivitySnapshot {
  useEffect(() => {
    startConnectivityMonitor();
  }, []);
  return useSyncExternalStore(
    subscribeToConnectivity,
    getConnectivitySnapshot,
    getConnectivitySnapshot,
  );
}

export function resetConnectivityForTests(
  nextState: Partial<ConnectivityState> = {},
): void {
  state = {
    browserOnline:
      typeof navigator === 'undefined' ? true : navigator.onLine,
    backendReachable: true,
    ...nextState,
  };
  snapshot = deriveSnapshot(state);
  emit();
}
