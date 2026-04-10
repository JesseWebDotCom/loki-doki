import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import ConnectivityBanner from '../../components/system/ConnectivityBanner';
import {
  markBackendOffline,
  markBackendReachable,
  resetConnectivityForTests,
  startConnectivityMonitor,
} from '../connectivity';

const realNavigator = globalThis.navigator;

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      ...realNavigator,
      onLine: value,
    },
  });
}

describe('ConnectivityBanner', () => {
  beforeEach(() => {
    setNavigatorOnline(true);
    resetConnectivityForTests({ browserOnline: true, backendReachable: true });
    startConnectivityMonitor();
  });

  afterEach(() => {
    cleanup();
    setNavigatorOnline(true);
    resetConnectivityForTests({ browserOnline: true, backendReachable: true });
  });

  it('renders a backend offline banner as soon as the API becomes unreachable', () => {
    render(<ConnectivityBanner />);
    expect(screen.queryByTestId('connectivity-banner')).toBeNull();

    act(() => {
      markBackendOffline();
    });

    expect(screen.getByTestId('connectivity-banner').textContent).toMatch(/Local backend offline/i);
  });

  it('renders a network offline banner on browser offline events and clears on recovery', () => {
    render(<ConnectivityBanner />);

    act(() => {
      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
    });

    expect(screen.getByTestId('connectivity-banner').textContent).toMatch(/Network offline/i);

    act(() => {
      setNavigatorOnline(true);
      window.dispatchEvent(new Event('online'));
      markBackendReachable();
    });

    expect(screen.queryByTestId('connectivity-banner')).toBeNull();
  });
});
