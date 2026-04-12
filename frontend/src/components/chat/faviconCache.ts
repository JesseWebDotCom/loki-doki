const STORAGE_PREFIX = 'lokidoki.favicon.';
const memoryCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function toKey(hostname: string): string {
  return `${STORAGE_PREFIX}${hostname.toLowerCase()}`;
}

function fallbackSvg(hostname: string): string {
  const label = hostname.replace(/^www\./i, '').charAt(0).toUpperCase() || 'S';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="16" fill="#15151d"/>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="none" stroke="#3b3b46"/>
      <text x="50%" y="54%" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#f5f5f7">${label}</text>
    </svg>
  `.trim();
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function readStored(hostname: string): string | null {
  const key = toKey(hostname);
  const memoized = memoryCache.get(key);
  if (memoized) return memoized;
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      memoryCache.set(key, stored);
      return stored;
    }
  } catch {
    // Storage can be unavailable in private browsing or constrained test envs.
  }
  return null;
}

function writeStored(hostname: string, dataUrl: string): void {
  const key = toKey(hostname);
  memoryCache.set(key, dataUrl);
  try {
    localStorage.setItem(key, dataUrl);
  } catch {
    // Ignore quota/storage failures; the in-memory cache still helps this session.
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Failed to read favicon blob'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read favicon blob'));
    reader.readAsDataURL(blob);
  });
}

export function getCachedFavicon(hostname: string): string | null {
  return readStored(hostname);
}

export function getFallbackFavicon(hostname: string): string {
  return fallbackSvg(hostname);
}

export async function ensureCachedFavicon(hostname: string, remoteUrl: string): Promise<string> {
  const cached = readStored(hostname);
  if (cached) return cached;

  const key = toKey(hostname);
  const existing = inflight.get(key);
  if (existing) return existing;

  const request = (async () => {
    try {
      const response = await fetch(remoteUrl);
      if (!response.ok) throw new Error(`favicon fetch failed: ${response.status}`);
      const blob = await response.blob();
      const dataUrl = await blobToDataUrl(blob);
      writeStored(hostname, dataUrl);
      return dataUrl;
    } catch {
      return fallbackSvg(hostname);
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, request);
  return request;
}

export function resetFaviconCacheForTests(): void {
  memoryCache.clear();
  inflight.clear();
}
