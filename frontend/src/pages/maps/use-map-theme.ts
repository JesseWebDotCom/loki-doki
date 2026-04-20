import { useEffect, useState } from 'react';
import { useTheme, type Theme } from '@/components/theme/ThemeProvider';

export type MapTheme = 'dark' | 'light';
export type MapThemePreference = MapTheme | 'system';

const STORAGE_KEY = 'lokidoki.mapTheme';
const EVENT_NAME = 'lokidoki.mapTheme';

function isPreference(value: string | null): value is MapThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

function readPreference(): MapThemePreference {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return isPreference(stored) ? stored : 'system';
}

function resolveSiteTheme(siteTheme: Theme): MapTheme {
  if (siteTheme === 'dark' || siteTheme === 'light') return siteTheme;
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

function resolveTheme(preference: MapThemePreference, siteTheme: MapTheme): MapTheme {
  return preference === 'system' ? siteTheme : preference;
}

export function setStoredMapTheme(preference: MapThemePreference): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, preference);
  window.dispatchEvent(
    new CustomEvent<MapThemePreference>(EVENT_NAME, { detail: preference }),
  );
}

export function useMapTheme(): {
  preference: MapThemePreference;
  theme: MapTheme;
  setTheme: (preference: MapThemePreference) => void;
} {
  const { theme: sitePreference } = useTheme();
  const [preference, setPreference] = useState<MapThemePreference>(() => readPreference());
  const [siteTheme, setSiteTheme] = useState<MapTheme>(() =>
    resolveSiteTheme(sitePreference),
  );

  useEffect(() => {
    if (sitePreference === 'dark' || sitePreference === 'light') {
      setSiteTheme(sitePreference);
      return undefined;
    }
    if (typeof document === 'undefined') {
      setSiteTheme('dark');
      return undefined;
    }

    const root = document.documentElement;
    const sync = () => {
      setSiteTheme(resolveSiteTheme(sitePreference));
    };
    const observer = new MutationObserver(sync);
    sync();
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
    };
  }, [sitePreference]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const sync = (nextPreference: MapThemePreference) => {
      setPreference(nextPreference);
    };
    const onCustom = (event: Event) => {
      const nextPreference = (event as CustomEvent<MapThemePreference>).detail;
      sync(nextPreference);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        sync(readPreference());
      }
    };

    sync(readPreference());
    window.addEventListener(EVENT_NAME, onCustom as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, onCustom as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return {
    preference,
    theme: resolveTheme(preference, siteTheme),
    setTheme: setStoredMapTheme,
  };
}
