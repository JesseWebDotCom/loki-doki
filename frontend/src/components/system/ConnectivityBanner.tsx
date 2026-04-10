import React from 'react';
import { ServerCrash, WifiOff } from 'lucide-react';
import { useConnectivityStatus } from '../../lib/connectivity';

const ConnectivityBanner: React.FC = () => {
  const connectivity = useConnectivityStatus();

  if (connectivity.status === 'online') return null;

  const isBackendOffline = connectivity.status === 'backend_offline';
  const Icon = isBackendOffline ? ServerCrash : WifiOff;
  const title = isBackendOffline
    ? 'Local backend offline'
    : 'Network offline';
  const detail = isBackendOffline
    ? 'LokiDoki cannot reach the local API right now. Requests will work again as soon as the backend reconnects.'
    : 'The device has no network connection. Local-only features may still work.';

  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-50 w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 px-4">
      <div
        className={`pointer-events-auto rounded-2xl border px-4 py-3 shadow-m4 backdrop-blur-xl ${
          isBackendOffline
            ? 'border-red-400/30 bg-red-950/80 text-red-50'
            : 'border-amber-400/30 bg-amber-950/80 text-amber-50'
        }`}
        data-testid="connectivity-banner"
        role="status"
        aria-live="polite"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-white/10 p-2">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-wide">{title}</p>
            <p className="text-sm opacity-90">{detail}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConnectivityBanner;
