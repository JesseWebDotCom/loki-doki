/** WizardPage form-validation tests. */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import WizardPage from "../WizardPage";
import { AuthProvider } from "../../auth/AuthProvider";

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function setup() {
  // /auth/me returns 409 so AuthProvider settles into needsBootstrap.
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ detail: "needs_bootstrap" }), {
        status: 409,
      });
    }
    if (url.endsWith("/auth/bootstrap")) {
      return new Response(
        JSON.stringify({ id: 1, username: "alice", role: "admin" }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  return render(
    <MemoryRouter initialEntries={["/wizard"]}>
      <AuthProvider>
        <WizardPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("WizardPage", () => {
  it("rejects PIN that is too short", async () => {
    const { getByTestId } = setup();
    fireEvent.change(getByTestId("wizard-username"), {
      target: { value: "alice" },
    });
    fireEvent.change(getByTestId("wizard-pin"), { target: { value: "12" } });
    fireEvent.change(getByTestId("wizard-pin2"), { target: { value: "12" } });
    fireEvent.change(getByTestId("wizard-pwd"), {
      target: { value: "password1" },
    });
    fireEvent.change(getByTestId("wizard-pwd2"), {
      target: { value: "password1" },
    });
    fireEvent.click(getByTestId("wizard-submit"));
    await waitFor(() =>
      expect(getByTestId("wizard-error").textContent).toMatch(/PIN/),
    );
  });

  it("rejects mismatched PINs", async () => {
    const { getByTestId } = setup();
    fireEvent.change(getByTestId("wizard-username"), {
      target: { value: "alice" },
    });
    fireEvent.change(getByTestId("wizard-pin"), { target: { value: "1234" } });
    fireEvent.change(getByTestId("wizard-pin2"), { target: { value: "5678" } });
    fireEvent.change(getByTestId("wizard-pwd"), {
      target: { value: "password1" },
    });
    fireEvent.change(getByTestId("wizard-pwd2"), {
      target: { value: "password1" },
    });
    fireEvent.click(getByTestId("wizard-submit"));
    await waitFor(() =>
      expect(getByTestId("wizard-error").textContent).toMatch(/match/),
    );
  });

  it("rejects short password", async () => {
    const { getByTestId } = setup();
    fireEvent.change(getByTestId("wizard-username"), {
      target: { value: "alice" },
    });
    fireEvent.change(getByTestId("wizard-pin"), { target: { value: "1234" } });
    fireEvent.change(getByTestId("wizard-pin2"), { target: { value: "1234" } });
    fireEvent.change(getByTestId("wizard-pwd"), { target: { value: "abc" } });
    fireEvent.change(getByTestId("wizard-pwd2"), { target: { value: "abc" } });
    fireEvent.click(getByTestId("wizard-submit"));
    await waitFor(() =>
      expect(getByTestId("wizard-error").textContent).toMatch(/8/),
    );
  });
});
