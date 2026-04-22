import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MessageItem from "../MessageItem";
import ModeToggle from "../ModeToggle";
import SourceSurface from "../SourceSurface";
import ArtifactSurface from "../artifact/ArtifactSurface";
import type { ResponseEnvelope } from "../../../lib/response-types";

function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width: 639px") ? matches : !matches,
      media: query,
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
    request_id: "req-kiosk",
    mode: "artifact",
    status: "complete",
    blocks: [
      { id: "summary", type: "summary", state: "ready", seq: 0, content: "Luke drafted a local artifact." },
    ],
    source_surface: [],
    artifact_surface: {
      artifact_id: "artifact-1",
      title: "Luke Clock",
      kind: "html",
      selected_version: 1,
      versions: [
        {
          version: 1,
          content: "<main>v1</main>",
          created_at: "2026-04-21T10:00:00Z",
          size_bytes: 16,
        },
      ],
    },
  };
}

beforeEach(() => {
  stubMatchMedia(true);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 640 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("kiosk layout polish", () => {
  it("keeps the summary and source surface mounted together for kiosk-sized turns", () => {
    render(
      <>
        <MessageItem
          role="assistant"
          content="Leia gathered the sources."
          timestamp="2026-04-21T12:00:00Z"
          sources={[{ title: "Leia dossier", url: "https://example.test/leia" }]}
        />
        <SourceSurface
          open
          onOpenChange={() => undefined}
          title="Leia gathered the sources."
          sources={[{ title: "Leia dossier", url: "https://example.test/leia" }]}
        />
      </>,
    );

    expect(screen.getAllByText("Leia gathered the sources.").length).toBeGreaterThan(0);
    expect(document.body.querySelector('[data-slot="source-surface"]')).toBeTruthy();
  });

  it("collapses the mode toggle to a compact picker on narrow viewports", () => {
    render(<ModeToggle value="auto" onChange={() => undefined} />);
    expect(screen.getByTestId("mode-toggle-compact")).toBeTruthy();
  });

  it("renders narrow artifact views as a dialog", () => {
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

  it("keeps narrow-touch controls at the 44px class budget", () => {
    render(
      <SourceSurface
        open
        onOpenChange={() => undefined}
        sources={[{ title: "Leia dossier", url: "https://example.test/leia" }]}
      />,
    );

    const compactToggle = render(<ModeToggle value="auto" onChange={() => undefined} />);
    expect(screen.getByTestId("mode-toggle-compact").className).toContain("h-11");
    expect(document.body.querySelector('[data-slot="use-source-next"]')?.className).toContain("h-11");
    compactToggle.unmount();
  });
});
