import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import SkillsSection from "../SkillsSection";
import { AuthContext, type AuthState } from "../../../auth/AuthProvider";

const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const authValue: AuthState = {
  currentUser: { id: 1, username: "admin", role: "admin" },
  needsBootstrap: false,
  loading: false,
  error: null,
  login: vi.fn(),
  logout: vi.fn(),
  bootstrap: vi.fn(),
  challengeAdmin: vi.fn(),
  refresh: vi.fn(),
};

describe("SkillsSection", () => {
  it("does not render the old admin badge in settings", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/v1/skills")) {
        return new Response(JSON.stringify({ skills: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    render(
      <AuthContext.Provider value={authValue}>
        <SkillsSection />
      </AuthContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Skills")).toBeTruthy();
    });

    expect(screen.queryByText("ADMIN")).toBeNull();
  });
});
