import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureCachedFavicon,
  getCachedFavicon,
  getFallbackFavicon,
  resetFaviconCacheForTests,
} from '../faviconCache';

const realFetch = globalThis.fetch;

describe('faviconCache', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetFaviconCacheForTests();
    vi.restoreAllMocks();
  });

  it('stores a fetched favicon and reuses it without another network call', async () => {
    const blob = new Blob(['icon'], { type: 'image/png' });
    globalThis.fetch = vi.fn(async () => new Response(blob, { status: 200 })) as typeof fetch;

    const first = await ensureCachedFavicon('example.com', 'https://icons.example.com/favicon.ico');
    const second = await ensureCachedFavicon('example.com', 'https://icons.example.com/favicon.ico');

    expect(first.startsWith('data:')).toBe(true);
    expect(second).toBe(first);
    expect(getCachedFavicon('example.com')).toBe(first);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to a local svg when fetching fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('offline');
    }) as typeof fetch;

    const icon = await ensureCachedFavicon('offline.example', 'https://icons.example.com/favicon.ico');

    expect(icon).toBe(getFallbackFavicon('offline.example'));
  });
});
