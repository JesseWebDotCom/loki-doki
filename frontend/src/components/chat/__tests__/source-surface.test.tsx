/**
 * Chunk 11 — SourceSurface + OfflineTrustChip + SourceCard tests.
 *
 * These tests pin chunk 11's public behavior:
 *
 *   * ``SourceSurface`` renders one ``SourceCard`` per
 *     ``envelope.source_surface`` entry (10 sources → 10 cards) and
 *     shows an empty-state message when the list is empty.
 *   * ``SourceCard`` surfaces the structured metadata (snippet, kind,
 *     author, date) when present and remains offline-safe — the
 *     favicon goes through ``FaviconImage`` which falls back to a
 *     generated SVG when the remote fetch fails (``faviconCache``
 *     never throws on offline).
 *   * ``OfflineTrustChip`` renders ONLY when the envelope's
 *     ``offline_degraded`` flag is true.
 *
 * Collocated under ``__tests__/`` so vitest's ``include`` glob picks
 * it up automatically.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MessageItem from "../MessageItem";
import OfflineTrustChip from "../OfflineTrustChip";
import SourceCard from "../SourceCard";
import SourceSurface from "../SourceSurface";
import type { StructuredSource } from "../SourceCard";
import type { ResponseEnvelope } from "../../../lib/response-types";

function makeSources(count: number): StructuredSource[] {
  // Pop-culture test names per CLAUDE.md's mocking rule.
  const seeds = [
    "Luke",
    "Leia",
    "Han",
    "Chewbacca",
    "Yoda",
    "Obi-Wan",
    "Padme",
    "Anakin",
    "Rey",
    "Finn",
    "Poe",
    "Kylo",
  ];
  return Array.from({ length: count }, (_, i) => {
    const name = seeds[i % seeds.length];
    return {
      title: `${name} profile`,
      url: `https://example.test/${name.toLowerCase()}`,
      kind: "web",
      snippet: `${name} is a key figure in the galactic story.`,
    };
  });
}

describe("SourceSurface", () => {
  // Radix Dialog / Sheet portals render outside the React root, so
  // we query ``document.body`` rather than the ``render`` container.
  // Explicit ``cleanup`` ensures portals from prior cases don't leak
  // into the next test (vitest autocleanup covers the render root but
  // portaled content sometimes lingers in the body).
  afterEach(() => {
    cleanup();
  });

  function portalQuery(selector: string): Element | null {
    return document.body.querySelector(selector);
  }
  function portalQueryAll(selector: string): NodeListOf<Element> {
    return document.body.querySelectorAll(selector);
  }

  it("renders one SourceCard per source (10 sources → 10 cards)", () => {
    const sources = makeSources(10);

    render(
      <SourceSurface
        open
        onOpenChange={() => {}}
        sources={sources}
        title="Galactic overview"
      />,
    );

    const list = portalQuery('[data-slot="source-surface-list"]');
    expect(list).toBeTruthy();
    const items = portalQueryAll(
      '[data-slot="source-surface-list"] > li',
    );
    expect(items.length).toBe(10);
  });

  it("renders an empty-state message when the surface has no sources", () => {
    render(<SourceSurface open onOpenChange={() => {}} sources={[]} />);

    expect(portalQuery('[data-slot="source-surface-empty"]')).toBeTruthy();
    expect(portalQuery('[data-slot="source-surface-list"]')).toBeNull();
  });

  it('shows a "Cited sources · N" header including the count', () => {
    const sources = makeSources(3);

    render(<SourceSurface open onOpenChange={() => {}} sources={sources} />);

    expect(screen.getByText(/Cited sources · 3/i)).toBeTruthy();
  });

  it("does not render drawer content when closed", () => {
    render(
      <SourceSurface
        open={false}
        onOpenChange={() => {}}
        sources={makeSources(3)}
      />,
    );

    // Radix unmounts the content when closed; no cards appear in the
    // DOM until open flips to true.
    expect(portalQuery('[data-slot="source-surface-list"]')).toBeNull();
  });

  it("mounts the surface root in a portal when open", () => {
    const onOpenChange = vi.fn();

    render(
      <SourceSurface
        open
        onOpenChange={onOpenChange}
        sources={makeSources(2)}
      />,
    );

    const root = portalQuery('[data-slot="source-surface"]');
    expect(root).toBeTruthy();
  });
});

describe("SourceCard", () => {
  it("renders the title, hostname, snippet, kind, and author metadata", () => {
    const { container } = render(
      <SourceCard
        source={{
          title: "Naboo — Wookieepedia",
          url: "https://example.test/naboo",
          kind: "web",
          snippet: "Naboo is a planet in the Chommell sector of the galaxy.",
          author: "Archivist",
          published_at: "2026-01-15",
        }}
      />,
    );

    expect(screen.getByText(/Naboo — Wookieepedia/i)).toBeTruthy();
    // Hostname appears at least once — the card renders it as the
    // secondary line under the title (truncation-safe for long URLs).
    const hostnameMatches = screen.getAllByText(/example\.test/);
    expect(hostnameMatches.length).toBeGreaterThan(0);
    expect(
      container.querySelector('[data-slot="source-snippet"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-slot="source-kind"]')?.textContent,
    ).toBe("web");
    const meta = container.querySelector('[data-slot="source-meta"]');
    expect(meta?.textContent).toContain("Archivist");
    expect(meta?.textContent).toContain("2026-01-15");
  });

  it("tolerates a source with only a title + url (optional fields omitted)", () => {
    const { container } = render(
      <SourceCard
        source={{
          title: "Minimal source",
          url: "https://example.test/min",
        }}
      />,
    );

    expect(screen.getByText(/Minimal source/i)).toBeTruthy();
    expect(
      container.querySelector('[data-slot="source-snippet"]'),
    ).toBeNull();
    expect(container.querySelector('[data-slot="source-kind"]')).toBeNull();
  });

  it("emits an <a target=_blank> link with noopener (no auto-fetch)", () => {
    const { container } = render(
      <SourceCard
        source={{ title: "Anchor test", url: "https://example.test/anchor" }}
      />,
    );

    const anchor = container.querySelector<HTMLAnchorElement>("a");
    expect(anchor).toBeTruthy();
    expect(anchor?.getAttribute("href")).toBe("https://example.test/anchor");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toContain("noopener");
  });
});

describe("OfflineTrustChip", () => {
  it('renders the "Offline — using local knowledge" message', () => {
    render(<OfflineTrustChip />);
    expect(
      screen.getByText(/Offline — using local knowledge/i),
    ).toBeTruthy();
  });

  it("carries role=status and a descriptive aria-label", () => {
    const { container } = render(<OfflineTrustChip />);
    const chip = container.querySelector(
      '[data-slot="offline-trust-chip"]',
    );
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("role")).toBe("status");
    expect(chip?.getAttribute("aria-label")?.toLowerCase()).toContain(
      "offline",
    );
  });
});

describe("MessageItem offline_degraded wiring", () => {
  it("mounts OfflineTrustChip only when envelope.offline_degraded is true", () => {
    const baseEnvelope = (offlineDegraded: boolean): ResponseEnvelope => ({
      request_id: "req-chip-1",
      mode: "standard",
      status: "complete",
      blocks: [
        {
          id: "summary",
          type: "summary",
          state: "ready",
          seq: 0,
          content: "Local-knowledge answer.",
        },
      ],
      source_surface: [],
      offline_degraded: offlineDegraded,
    });

    const offline = render(
      <MessageItem
        role="assistant"
        content="Local-knowledge answer."
        timestamp="2026-04-21T12:00:00Z"
        envelope={baseEnvelope(true)}
      />,
    );
    expect(
      offline.container.querySelector('[data-slot="offline-trust-chip"]'),
    ).toBeTruthy();
    offline.unmount();

    const online = render(
      <MessageItem
        role="assistant"
        content="Regular answer."
        timestamp="2026-04-21T12:00:00Z"
        envelope={baseEnvelope(false)}
      />,
    );
    expect(
      online.container.querySelector('[data-slot="offline-trust-chip"]'),
    ).toBeNull();
    online.unmount();
  });
});

describe("SourcesBlock overflow escape", () => {
  it("shows inline SourceChips for ≤ 4 sources and hides the view-all button", () => {
    const sources = makeSources(3);
    const envelope: ResponseEnvelope = {
      request_id: "req-ov-small",
      mode: "standard",
      status: "complete",
      blocks: [
        {
          id: "summary",
          type: "summary",
          state: "ready",
          seq: 0,
          content: "Short answer.",
        },
        {
          id: "sources",
          type: "sources",
          state: "ready",
          seq: 0,
          items: sources,
        },
      ],
      source_surface: sources,
    };

    const { container } = render(
      <MessageItem
        role="assistant"
        content="Short answer."
        timestamp="2026-04-21T12:00:00Z"
        envelope={envelope}
      />,
    );

    const block = container.querySelector('[data-slot="sources-block"]');
    expect(block).toBeTruthy();
    expect(block?.getAttribute("data-source-count")).toBe("3");
    expect(
      container.querySelector('[data-slot="sources-view-all"]'),
    ).toBeNull();
  });

  it('shows a "View all N sources" button when the list overflows', () => {
    const sources = makeSources(10);
    const envelope: ResponseEnvelope = {
      request_id: "req-ov-big",
      mode: "standard",
      status: "complete",
      blocks: [
        {
          id: "summary",
          type: "summary",
          state: "ready",
          seq: 0,
          content: "Long answer.",
        },
        {
          id: "sources",
          type: "sources",
          state: "ready",
          seq: 0,
          items: sources,
        },
      ],
      source_surface: sources,
    };

    const onOpenSources = vi.fn();
    const { container } = render(
      <MessageItem
        role="assistant"
        content="Long answer."
        timestamp="2026-04-21T12:00:00Z"
        envelope={envelope}
        onOpenSources={onOpenSources}
      />,
    );

    const block = container.querySelector(
      '[data-slot="sources-block"]',
    ) as HTMLElement;
    expect(block).toBeTruthy();
    expect(block?.getAttribute("data-source-count")).toBe("10");
    const viewAll = within(block).getByRole("button", {
      name: /view all 10 sources/i,
    });
    expect(viewAll).toBeTruthy();
    viewAll.click();
    expect(onOpenSources).toHaveBeenCalled();
  });
});
