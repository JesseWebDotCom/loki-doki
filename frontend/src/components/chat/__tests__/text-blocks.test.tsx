import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Block } from "../../../lib/response-types";
import KeyFactsBlock from "../blocks/KeyFactsBlock";
import StepsBlock from "../blocks/StepsBlock";
import ComparisonBlock from "../blocks/ComparisonBlock";
import { renderBlock } from "../blocks";

/**
 * Chunk 14 — text-heavy block renderers.
 *
 * Covers the five block-state transitions (loading / partial / ready
 * / omitted / failed) for each of ``KeyFactsBlock``, ``StepsBlock``,
 * and ``ComparisonBlock``. Exercises the block-registry entry too so
 * a backend envelope carrying these block types renders without the
 * registry falling back to ``null``.
 */

function readyBlock(overrides: Partial<Block>): Block {
  return {
    id: "text-block",
    type: "key_facts",
    state: "ready",
    seq: 0,
    ...overrides,
  };
}

describe("KeyFactsBlock", () => {
  it("renders bullet items when ready", () => {
    const block = readyBlock({
      id: "facts",
      type: "key_facts",
      items: [{ text: "Luke is a Jedi." }, { text: "Leia is a senator." }],
    });

    const { container } = render(<KeyFactsBlock block={block} />);

    const marker = container.querySelector('[data-slot="key-facts-block"]');
    expect(marker).toBeTruthy();
    expect(marker?.getAttribute("data-fact-count")).toBe("2");
    expect(screen.getByText("Luke is a Jedi.")).toBeTruthy();
    expect(screen.getByText("Leia is a senator.")).toBeTruthy();
  });

  it("renders the placeholder skeleton while loading", () => {
    const block: Block = {
      id: "facts",
      type: "key_facts",
      state: "loading",
      seq: 0,
    };

    const { container } = render(<KeyFactsBlock block={block} />);

    expect(
      container.querySelector('[data-slot="key-facts-skeleton"]'),
    ).toBeTruthy();
    expect(container.querySelector('[data-slot="block-loading"]')).toBeTruthy();
  });

  it("renders nothing when omitted", () => {
    const block: Block = {
      id: "facts",
      type: "key_facts",
      state: "omitted",
      seq: 0,
      items: [],
    };

    const { container } = render(<KeyFactsBlock block={block} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a muted failure chip with reason", () => {
    const block: Block = {
      id: "facts",
      type: "key_facts",
      state: "failed",
      seq: 0,
      reason: "skill timeout",
    };

    const { container } = render(<KeyFactsBlock block={block} />);
    expect(container.querySelector('[data-slot="block-failed"]')).toBeTruthy();
    expect(screen.getByText("skill timeout")).toBeTruthy();
  });
});

describe("StepsBlock", () => {
  it("renders numbered steps when ready", () => {
    const block: Block = {
      id: "steps",
      type: "steps",
      state: "ready",
      seq: 0,
      items: [
        { n: 1, text: "Turn off the water." },
        { n: 2, text: "Remove the handle." },
        {
          n: 3,
          text: "Replace the washer.",
          substeps: ["Unscrew the cap", "Swap the ring"],
        },
      ],
    };

    const { container } = render(<StepsBlock block={block} />);

    const marker = container.querySelector('[data-slot="steps-block"]');
    expect(marker).toBeTruthy();
    expect(marker?.getAttribute("data-step-count")).toBe("3");
    expect(screen.getByText("Turn off the water.")).toBeTruthy();
    expect(screen.getByText("Replace the washer.")).toBeTruthy();
    expect(screen.getByText("Unscrew the cap")).toBeTruthy();
  });

  it("renders a skeleton while partial (no renderPartial opt-in)", () => {
    const block: Block = {
      id: "steps",
      type: "steps",
      state: "partial",
      seq: 1,
      items: [],
    };

    const { container } = render(<StepsBlock block={block} />);

    expect(container.querySelector('[data-slot="steps-skeleton"]')).toBeTruthy();
  });

  it("renders nothing when omitted", () => {
    const block: Block = {
      id: "steps",
      type: "steps",
      state: "omitted",
      seq: 0,
      items: [],
    };

    const { container } = render(<StepsBlock block={block} />);
    expect(container.firstChild).toBeNull();
  });

  it("drops steps with empty text instead of rendering blanks", () => {
    const block: Block = {
      id: "steps",
      type: "steps",
      state: "ready",
      seq: 0,
      items: [
        { n: 1, text: "Real step" },
        { n: 2, text: "   " },
        { n: 3, text: "" },
      ],
    };

    const { container } = render(<StepsBlock block={block} />);

    const marker = container.querySelector('[data-slot="steps-block"]');
    expect(marker?.getAttribute("data-step-count")).toBe("1");
  });
});

describe("ComparisonBlock", () => {
  it("renders a two-column layout with aligned dimensions", () => {
    const block: Block = {
      id: "comparison",
      type: "comparison",
      state: "ready",
      seq: 0,
      comparison: {
        left: {
          title: "Wikipedia",
          items: ["encyclopedia", "multilingual"],
        },
        right: {
          title: "Wikimedia Foundation",
          items: ["umbrella org", "hosts projects"],
        },
        dimensions: ["purpose", "scope"],
      },
    };

    const { container } = render(<ComparisonBlock block={block} />);

    expect(
      container.querySelector('[data-slot="comparison-block"]'),
    ).toBeTruthy();
    const rows = container.querySelectorAll('[data-slot="comparison-row"]');
    expect(rows.length).toBe(2);
    expect(screen.getByText("Wikipedia")).toBeTruthy();
    expect(screen.getByText("Wikimedia Foundation")).toBeTruthy();
    expect(screen.getByText("encyclopedia")).toBeTruthy();
  });

  it("falls back to a bulleted two-column layout when dimensions are absent", () => {
    const block: Block = {
      id: "comparison",
      type: "comparison",
      state: "ready",
      seq: 0,
      comparison: {
        left: { title: "Luke", items: ["jedi", "pilot"] },
        right: { title: "Leia", items: ["senator"] },
        dimensions: [],
      },
    };

    const { container } = render(<ComparisonBlock block={block} />);

    expect(
      container.querySelector('[data-slot="comparison-items"]'),
    ).toBeTruthy();
    expect(screen.getByText("jedi")).toBeTruthy();
    expect(screen.getByText("senator")).toBeTruthy();
  });

  it("renders just the subject titles when no items or dimensions are populated", () => {
    const block: Block = {
      id: "comparison",
      type: "comparison",
      state: "ready",
      seq: 0,
      comparison: {
        left: { title: "Anakin", items: [] },
        right: { title: "Padme", items: [] },
        dimensions: [],
      },
    };

    const { container } = render(<ComparisonBlock block={block} />);

    expect(
      container.querySelector('[data-slot="comparison-block"]'),
    ).toBeTruthy();
    expect(screen.getByText("Anakin")).toBeTruthy();
    expect(screen.getByText("Padme")).toBeTruthy();
    expect(
      container.querySelector('[data-slot="comparison-rows"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-slot="comparison-items"]'),
    ).toBeNull();
  });

  it("renders the comparison skeleton while loading", () => {
    const block: Block = {
      id: "comparison",
      type: "comparison",
      state: "loading",
      seq: 0,
    };

    const { container } = render(<ComparisonBlock block={block} />);

    expect(
      container.querySelector('[data-slot="comparison-skeleton"]'),
    ).toBeTruthy();
  });

  it("renders nothing when omitted", () => {
    const block: Block = {
      id: "comparison",
      type: "comparison",
      state: "omitted",
      seq: 0,
    };

    const { container } = render(<ComparisonBlock block={block} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("block registry text-block wiring", () => {
  it("dispatches key_facts / steps / comparison via renderBlock", () => {
    const keyFacts: Block = {
      id: "kf",
      type: "key_facts",
      state: "ready",
      seq: 0,
      items: [{ text: "Yoda is wise." }],
    };
    const steps: Block = {
      id: "sp",
      type: "steps",
      state: "ready",
      seq: 0,
      items: [{ n: 1, text: "Breathe in." }],
    };
    const comparison: Block = {
      id: "cmp",
      type: "comparison",
      state: "ready",
      seq: 0,
      comparison: {
        left: { title: "Sith", items: [] },
        right: { title: "Jedi", items: [] },
        dimensions: [],
      },
    };

    render(
      <>
        {renderBlock(keyFacts)}
        {renderBlock(steps)}
        {renderBlock(comparison)}
      </>,
    );

    expect(screen.getByText("Yoda is wise.")).toBeTruthy();
    expect(screen.getByText("Breathe in.")).toBeTruthy();
    expect(screen.getByText("Sith")).toBeTruthy();
    expect(screen.getByText("Jedi")).toBeTruthy();
  });
});
