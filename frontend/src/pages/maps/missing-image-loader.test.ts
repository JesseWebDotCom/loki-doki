import { describe, expect, it, vi } from 'vitest';
import { installMissingImageLoader } from './missing-image-loader';

describe('installMissingImageLoader', () => {
  it('re-loads a missing icon after a style swap clears runtime images', async () => {
    const handlers = new Map<string, (event: { id?: string }) => void>();
    const images = new Set<string>();
    class FakeImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      crossOrigin = '';
      private _src = '';

      set src(value: string) {
        this._src = value;
        queueMicrotask(() => this.onload?.());
      }

      get src() {
        return this._src;
      }
    }

    const originalImage = globalThis.Image;
    vi.stubGlobal('Image', FakeImage);

    const map = {
      on: vi.fn((event: string, handler: (payload: { id?: string }) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn((event: string) => {
        handlers.delete(event);
      }),
      hasImage: vi.fn((id: string) => images.has(id)),
      addImage: vi.fn((id: string) => {
        images.add(id);
      }),
      getStyle: vi.fn(() => ({ version: 8 })),
    };

    try {
      installMissingImageLoader(map as never);
      const fireMissing = async (id: string) => {
        handlers.get('styleimagemissing')?.({ id });
        await Promise.resolve();
      };

      await fireMissing('cafe');
      expect(map.addImage).toHaveBeenCalledTimes(1);
      expect(map.addImage).toHaveBeenLastCalledWith(
        'cafe',
        expect.any(FakeImage),
        { sdf: true },
      );

      images.clear();
      await fireMissing('cafe');
      expect(map.addImage).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      globalThis.Image = originalImage;
    }
  });

  it('does not start duplicate fetches while an icon request is in flight', () => {
    const handlers = new Map<string, (event: { id?: string }) => void>();
    let triggerLoad: VoidFunction | undefined;
    class FakeImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      crossOrigin = '';
      set src(_value: string) {
        triggerLoad = this.onload ?? undefined;
      }
    }

    const originalImage = globalThis.Image;
    vi.stubGlobal('Image', FakeImage);

    const map = {
      on: vi.fn((event: string, handler: (payload: { id?: string }) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn(),
      hasImage: vi.fn(() => false),
      addImage: vi.fn(),
      getStyle: vi.fn(() => ({ version: 8 })),
    };

    try {
      installMissingImageLoader(map as never);
      const handler = handlers.get('styleimagemissing');
      handler?.({ id: 'restaurant' });
      handler?.({ id: 'restaurant' });
      expect(map.addImage).not.toHaveBeenCalled();

      expect(triggerLoad).toBeTypeOf('function');
      if (typeof triggerLoad === 'function') triggerLoad();
      expect(map.addImage).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      globalThis.Image = originalImage;
    }
  });
});
