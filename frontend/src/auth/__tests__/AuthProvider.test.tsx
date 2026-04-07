/**
 * AuthProvider behavior pinned: 200, 401, 409 from /auth/me each map
 * to the right state.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import { AuthProvider } from "../AuthProvider";
import { useAuth } from "../useAuth";

const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

beforeEach(() => {});

const Probe: React.FC = () => {
  const { currentUser, needsBootstrap, loading } = useAuth();
  if (loading) return <div data-testid="state">loading</div>;
  if (needsBootstrap) return <div data-testid="state">bootstrap</div>;
  if (currentUser) return <div data-testid="state">user:{currentUser.username}</div>;
  return <div data-testid="state">anon</div>;
};

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("AuthProvider", () => {
  it("populates currentUser on /me 200", async () => {
    mockFetch(200, { id: 1, username: "alice", role: "admin" });
    const { getByTestId } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(getByTestId("state").textContent).toBe("user:alice"),
    );
  });

  it("sets needsBootstrap on /me 409", async () => {
    mockFetch(409, { detail: "needs_bootstrap" });
    const { getByTestId } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(getByTestId("state").textContent).toBe("bootstrap"),
    );
  });

  it("leaves currentUser null on /me 401", async () => {
    mockFetch(401, { detail: "not_authenticated" });
    const { getByTestId } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(getByTestId("state").textContent).toBe("anon"),
    );
  });
});
