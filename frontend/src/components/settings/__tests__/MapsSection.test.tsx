import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MapsSection from "../MapsSection";

const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;
const realLocalStorage = globalThis.localStorage;

class MockEventSource {
  static instances: MockEventSource[] = [];

  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  url: string;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn(() => "test-token"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    },
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: realLocalStorage,
  });
  vi.restoreAllMocks();
});

describe("MapsSection", () => {
  it("reconciles installed state when the progress stream comes back idle", async () => {
    let regionsCall = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/v1/maps/catalog")) {
        return new Response(JSON.stringify({
          regions: [{
            region_id: "us-ct",
            label: "Connecticut",
            parent_id: "us",
            center: { lat: 41.6, lon: -72.7 },
            bbox: [-73.7, 40.9, -71.7, 42.1],
            sizes_mb: { street: 97, valhalla: 93, pbf: 134 },
            downloadable: true,
            pi_local_build_ok: true,
            children: [],
          }],
        }), { status: 200 });
      }
      if (url.endsWith("/api/v1/maps/regions") && !init?.method) {
        regionsCall += 1;
        const body = regionsCall === 1
          ? []
          : [{
              region_id: "us-ct",
              label: "Connecticut",
              config: { region_id: "us-ct", street: true },
              state: {
                region_id: "us-ct",
                street_installed: true,
                valhalla_installed: true,
                geocoder_installed: true,
                pbf_installed: false,
                bytes_on_disk: { geocoder: 100, street: 200, valhalla: 300 },
              },
            }];
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (url.endsWith("/api/v1/maps/regions/us-ct") && init?.method === "PUT") {
        return new Response(JSON.stringify({ ok: true, installing: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<MapsSection />);

    await waitFor(() => {
      expect(screen.getByText("Connecticut")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Install 1 change/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Installing…" })).toBeTruthy();
    });

    act(() => {
      MockEventSource.instances[0].onmessage?.({
        data: JSON.stringify({ status: "idle", region_id: "us-ct" }),
      } as MessageEvent<string>);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(screen.queryByRole("button", { name: "Installing…" })).toBeNull();
    });
  });

  it("clears stale progress when install task disappears", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/v1/maps/catalog")) {
        return new Response(JSON.stringify({
          regions: [{
            region_id: "us-ct",
            label: "Connecticut",
            parent_id: "us",
            center: { lat: 41.6, lon: -72.7 },
            bbox: [-73.7, 40.9, -71.7, 42.1],
            sizes_mb: { street: 97, valhalla: 93, pbf: 134 },
            downloadable: true,
            pi_local_build_ok: true,
            children: [],
          }],
        }), { status: 200 });
      }
      if (url.endsWith("/api/v1/maps/regions")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/api/v1/maps/regions/us-ct") && init?.method === "PUT") {
        return new Response(JSON.stringify({ ok: true, installing: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<MapsSection />);

    await waitFor(() => {
      expect(screen.getByText("Connecticut")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Install 1 change/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    act(() => {
      MockEventSource.instances[0].onmessage?.({
        data: JSON.stringify({
          region_id: "us-ct",
          artifact: "geocoder",
          bytes_done: 29000,
          bytes_total: 0,
          phase: "building_geocoder",
          error: null,
        }),
      } as MessageEvent<string>);
    });

    await waitFor(() => {
      expect(screen.getByText("Indexing addresses")).toBeTruthy();
      expect(screen.getByText("29k rows")).toBeTruthy();
    });

    act(() => {
      MockEventSource.instances[0].onerror?.();
    });

    await waitFor(() => {
      expect(screen.queryByText("Indexing addresses")).toBeNull();
      expect(screen.queryByText("29k rows")).toBeNull();
      expect(screen.queryByRole("button", { name: "Installing…" })).toBeNull();
    });
  });
});
