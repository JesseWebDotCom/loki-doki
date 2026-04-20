import { Fragment, createElement, type ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '@/components/theme/ThemeProvider';
import {
  setStoredMapTheme,
  useMapTheme,
} from './use-map-theme';

const realLocalStorage = window.localStorage;

function HookProbe() {
  const { preference, theme, setTheme } = useMapTheme();
  return createElement(
    'div',
    undefined,
    createElement('div', { 'data-testid': 'preference' }, preference),
    createElement('div', { 'data-testid': 'theme' }, theme),
    createElement(
      'button',
      { onClick: () => setTheme('dark'), type: 'button' },
      'set-dark',
    ),
  );
}

function ThemeFlipButton() {
  const { setTheme } = useTheme();
  return createElement(
    'button',
    { onClick: () => setTheme('dark'), type: 'button' },
    'set-site-dark',
  );
}

function renderWithThemeProvider(children: ReactNode, defaultTheme: 'light' | 'dark' | 'system' = 'light') {
  return render(
    createElement(
      ThemeProvider,
      { defaultTheme, storageKey: 'lokidoki-theme-test', children },
    ),
  );
}

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: realLocalStorage,
  });
  vi.restoreAllMocks();
});

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
    },
  });
});

describe('useMapTheme', () => {
  it('defaults to the site theme via ThemeProvider', () => {
    renderWithThemeProvider(createElement(HookProbe), 'light');
    expect(screen.getByTestId('preference').textContent).toBe('system');
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });

  it('follows the site theme when it flips', () => {
    renderWithThemeProvider(
      createElement(
        Fragment,
        undefined,
        createElement(HookProbe),
        createElement(ThemeFlipButton),
      ),
      'light',
    );
    expect(screen.getByTestId('theme').textContent).toBe('light');

    act(() => {
      screen.getByText('set-site-dark').click();
    });

    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('explicit map override wins over site theme', () => {
    window.localStorage.setItem('lokidoki.mapTheme', 'dark');
    renderWithThemeProvider(createElement(HookProbe), 'light');
    expect(screen.getByTestId('preference').textContent).toBe('dark');
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('syncs hook instances through the custom theme event', () => {
    renderWithThemeProvider(createElement(HookProbe), 'light');
    expect(screen.getByTestId('preference').textContent).toBe('system');

    act(() => {
      setStoredMapTheme('dark');
    });

    expect(screen.getByTestId('preference').textContent).toBe('dark');
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });
});
