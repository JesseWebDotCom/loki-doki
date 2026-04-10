import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ThemeShowcase from "../ThemeShowcase";
import { ThemeProvider } from "../ThemeProvider";

const storage = new Map<string, string>();

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(window, "localStorage", {
    writable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    },
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ThemeShowcase", () => {
  it("shows compact light and dark previews without the old heading", () => {
    render(
      <ThemeProvider storageKey="theme-showcase-test">
        <ThemeShowcase />
      </ThemeProvider>,
    );

    expect(screen.getByText("Light Mode")).toBeTruthy();
    expect(screen.getByText("Dark Mode")).toBeTruthy();
    expect(screen.queryByText("Live Authoritative Preview")).toBeNull();
  });
});
