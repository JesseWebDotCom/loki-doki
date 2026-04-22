import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MessageItem from "../MessageItem";
import ArtifactSurface from "../artifact/ArtifactSurface";
import type { ResponseEnvelope } from "../../../lib/response-types";

function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      media: "(min-width: 1280px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function artifactEnvelope(): ResponseEnvelope {
  return {
    request_id: "req-artifact",
    mode: "artifact",
    status: "complete",
    blocks: [
      {
        id: "summary",
        type: "summary",
        state: "ready",
        seq: 1,
        content: "Rendered a local artifact.",
      },
      {
        id: "artifact_preview",
        type: "artifact_preview",
        state: "ready",
        seq: 0,
        items: [
          {
            artifact_id: "artifact-1",
            title: "Luke Clock",
            kind: "html",
            version: 2,
            preview_text: "<main>A static preview</main>",
          },
        ],
      },
    ],
    source_surface: [],
    artifact_surface: {
      artifact_id: "artifact-1",
      title: "Luke Clock",
      kind: "html",
      selected_version: 2,
      versions: [
        {
          version: 1,
          content: "<main>v1</main>",
          created_at: "2026-04-21T10:00:00Z",
          size_bytes: 16,
        },
        {
          version: 2,
          content: "<main>v2</main>",
          created_at: "2026-04-21T10:05:00Z",
          size_bytes: 16,
        },
      ],
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  stubMatchMedia(true);
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

describe("ArtifactSurface", () => {
  it("renders as a right-side sheet on wide viewports", () => {
    render(
      <ArtifactSurface
        open
        onOpenChange={() => undefined}
        artifact={artifactEnvelope().artifact_surface as NonNullable<ResponseEnvelope["artifact_surface"]>}
      />,
    );

    expect(document.body.querySelector('[data-slot="artifact-surface-sheet"]')).toBeTruthy();
    expect(document.body.querySelector('[data-slot="artifact-surface-dialog"]')).toBeNull();
  });

  it("renders as a dialog on narrow viewports", () => {
    stubMatchMedia(false);

    render(
      <ArtifactSurface
        open
        onOpenChange={() => undefined}
        artifact={artifactEnvelope().artifact_surface as NonNullable<ResponseEnvelope["artifact_surface"]>}
      />,
    );

    expect(document.body.querySelector('[data-slot="artifact-surface-dialog"]')).toBeTruthy();
    expect(document.body.querySelector('[data-slot="artifact-surface-sheet"]')).toBeNull();
  });

  it("cycles versions and revert creates version n+1", async () => {
    render(
      <ArtifactSurface
        open
        onOpenChange={() => undefined}
        artifact={artifactEnvelope().artifact_surface as NonNullable<ResponseEnvelope["artifact_surface"]>}
      />,
    );

    expect(screen.getByText("v2 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /previous version/i }));
    expect(screen.getByText("v1 of 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /revert to this version/i }));
    fireEvent.click(screen.getByRole("button", { name: /^revert$/i }));

    await waitFor(() => {
      expect(screen.getByText("v3 of 3")).toBeTruthy();
    });
  });

  it("exports via local blob without calling fetch", async () => {
    const fetchSpy = vi.spyOn(window, "fetch");
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(
      <ArtifactSurface
        open
        onOpenChange={() => undefined}
        artifact={artifactEnvelope().artifact_surface as NonNullable<ResponseEnvelope["artifact_surface"]>}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /export artifact/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /save as \.html/i }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalledOnce();
  });
});

describe("MessageItem artifact wiring", () => {
  it("preview block click opens the surface and mounts SandboxedFrame exactly once", async () => {
    render(
      <MessageItem
        role="assistant"
        content="Rendered a local artifact."
        timestamp="2026-04-21T12:00:00Z"
        envelope={artifactEnvelope()}
      />,
    );

    expect(document.body.querySelector('[data-slot="artifact-sandbox"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /open artifact/i }));

    await waitFor(() => {
      expect(document.body.querySelectorAll('[data-slot="artifact-sandbox"]')).toHaveLength(1);
    });
  });
});
