import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { Block } from "../../../lib/response-types";
import FollowUpsBlock from "../blocks/FollowUpsBlock";
import ClarificationBlock from "../blocks/ClarificationBlock";
import StatusBlock from "../blocks/StatusBlock";
import { BlockContextProvider, renderBlock } from "../blocks";

/**
 * Chunk 15 — meta-block renderers (follow_ups / clarification /
 * status).
 *
 * Covers:
 *   * Registry wiring: each block type dispatches via ``renderBlock``.
 *   * No-fabrication contract: ``FollowUpsBlock`` renders nothing
 *     when the item list is empty (even at ``ready``), matching the
 *     backend planner's rule.
 *   * Click path: both follow-up chips and clarification quick-reply
 *     chips route their text through ``onFollowUp``.
 *   * Voice surface: the clarification block carries
 *     ``data-speakable`` (spoken per design §22) and the status
 *     block exposes ``data-speakable-phrase`` so the TTS pipeline
 *     can pick it up.
 *   * Omitted state: ``StatusBlock`` renders nothing when omitted
 *     (design §22 — the status is a live-only surface).
 */

function withContext(
  node: React.ReactNode,
  overrides: {
    onFollowUp?: (text: string) => void;
  } = {},
) {
  return render(
    <BlockContextProvider
      sources={[]}
      mentionedPeople={[]}
      onFollowUp={overrides.onFollowUp}
    >
      {node}
    </BlockContextProvider>,
  );
}

describe("FollowUpsBlock", () => {
  it("renders up to four chips from canonical item shape", () => {
    const block: Block = {
      id: "follow_ups",
      type: "follow_ups",
      state: "ready",
      seq: 0,
      items: [
        { text: "what about Naboo?" },
        { text: "tell me about her son" },
        { text: "how did she die?" },
        { text: "who was her husband?" },
        { text: "extra chip that should be dropped" },
      ],
    };

    const { container } = withContext(<FollowUpsBlock block={block} />);

    const chips = container.querySelectorAll('[data-slot="follow-ups-chip"]');
    expect(chips.length).toBe(4);
    expect(screen.getByText("what about Naboo?")).toBeTruthy();
    expect(
      container.querySelector('[data-slot="follow-ups-block"]')
        ?.getAttribute("data-chip-count"),
    ).toBe("4");
  });

  it("accepts bare-string item entries for adapter drift tolerance", () => {
    const block: Block = {
      id: "follow_ups",
      type: "follow_ups",
      state: "ready",
      seq: 0,
      items: ["search wiki", "try again"] as unknown as Record<string, unknown>[],
    };

    withContext(<FollowUpsBlock block={block} />);

    expect(screen.getByText("search wiki")).toBeTruthy();
    expect(screen.getByText("try again")).toBeTruthy();
  });

  it("fires onFollowUp with the chip text when clicked", () => {
    const onFollowUp = vi.fn();
    const block: Block = {
      id: "follow_ups",
      type: "follow_ups",
      state: "ready",
      seq: 0,
      items: [{ text: "ask Yoda" }],
    };

    withContext(<FollowUpsBlock block={block} />, { onFollowUp });

    fireEvent.click(screen.getByText("ask Yoda"));
    expect(onFollowUp).toHaveBeenCalledWith("ask Yoda");
  });

  it("renders nothing when the item list is empty (no fabrication)", () => {
    const block: Block = {
      id: "follow_ups",
      type: "follow_ups",
      state: "ready",
      seq: 0,
      items: [],
    };

    const { container } = withContext(<FollowUpsBlock block={block} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the only items are blank strings", () => {
    const block: Block = {
      id: "follow_ups",
      type: "follow_ups",
      state: "ready",
      seq: 0,
      items: [{ text: "   " }, { text: "" }],
    };

    const { container } = withContext(<FollowUpsBlock block={block} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing until the block is ready", () => {
    const block: Block = {
      id: "follow_ups",
      type: "follow_ups",
      state: "loading",
      seq: 0,
      items: [{ text: "placeholder so the block is non-empty" }],
    };

    const { container } = withContext(<FollowUpsBlock block={block} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("ClarificationBlock", () => {
  it("renders the question text in a highlighted card", () => {
    const block: Block = {
      id: "clarification",
      type: "clarification",
      state: "ready",
      seq: 0,
      content: "Which place — the one near the park, or downtown?",
    };

    const { container } = withContext(<ClarificationBlock block={block} />);

    const card = container.querySelector('[data-slot="clarification-block"]');
    expect(card).toBeTruthy();
    expect(screen.getByText(/Which place/)).toBeTruthy();
  });

  it("marks the card as speakable so TTS can read the question", () => {
    const block: Block = {
      id: "clarification",
      type: "clarification",
      state: "ready",
      seq: 0,
      content: "Did you mean Luke or Leia?",
    };

    const { container } = withContext(<ClarificationBlock block={block} />);

    const card = container.querySelector('[data-slot="clarification-block"]');
    expect(card?.getAttribute("data-speakable")).toBe("true");
  });

  it("renders quick-reply chips and routes clicks through onFollowUp", () => {
    const onFollowUp = vi.fn();
    const block: Block = {
      id: "clarification",
      type: "clarification",
      state: "ready",
      seq: 0,
      content: "Which Skywalker?",
      items: [{ text: "Luke" }, { text: "Leia" }, { text: "Anakin" }],
    };

    const { container } = withContext(
      <ClarificationBlock block={block} />,
      { onFollowUp },
    );

    const chips = container.querySelectorAll('[data-slot="clarification-chip"]');
    expect(chips.length).toBe(3);
    fireEvent.click(screen.getByText("Luke"));
    expect(onFollowUp).toHaveBeenCalledWith("Luke");
  });

  it("tolerates bare-string items", () => {
    const block: Block = {
      id: "clarification",
      type: "clarification",
      state: "ready",
      seq: 0,
      content: "Which?",
      items: ["A", "B"] as unknown as Record<string, unknown>[],
    };

    withContext(<ClarificationBlock block={block} />);
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("B")).toBeTruthy();
  });

  it("renders nothing when no question and no chips are present", () => {
    const block: Block = {
      id: "clarification",
      type: "clarification",
      state: "ready",
      seq: 0,
      content: "",
      items: [],
    };

    const { container } = withContext(<ClarificationBlock block={block} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("StatusBlock", () => {
  it("renders the phrase with a pulse when state is partial", () => {
    const block: Block = {
      id: "status",
      type: "status",
      state: "partial",
      seq: 2,
      content: "Checking sources",
    };

    const { container } = render(<StatusBlock block={block} />);

    const el = container.querySelector('[data-slot="status-block"]');
    expect(el).toBeTruthy();
    expect(el?.getAttribute("data-state")).toBe("partial");
    expect(screen.getByText("Checking sources")).toBeTruthy();
    expect(
      container.querySelector('[data-slot="status-pulse"]'),
    ).toBeTruthy();
  });

  it("exposes the phrase via data-speakable-phrase so TTS can throttle", () => {
    const block: Block = {
      id: "status",
      type: "status",
      state: "partial",
      seq: 1,
      content: "Looking up context",
    };

    const { container } = render(<StatusBlock block={block} />);
    const el = container.querySelector('[data-slot="status-block"]');
    expect(el?.getAttribute("data-speakable-phrase")).toBe("Looking up context");
  });

  it("renders an empty placeholder while loading and before the first patch", () => {
    const block: Block = {
      id: "status",
      type: "status",
      state: "loading",
      seq: 0,
    };

    const { container } = render(<StatusBlock block={block} />);
    const el = container.querySelector('[data-slot="status-block"]');
    expect(el).toBeTruthy();
    // No phrase yet → the speakable attribute is absent so TTS skips.
    expect(el?.getAttribute("data-speakable-phrase")).toBeNull();
  });

  it("renders nothing when omitted (design §22 — live-only surface)", () => {
    const block: Block = {
      id: "status",
      type: "status",
      state: "omitted",
      seq: 99,
      content: "ignored",
    };

    const { container } = render(<StatusBlock block={block} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when failed — status never double-reports errors", () => {
    const block: Block = {
      id: "status",
      type: "status",
      state: "failed",
      seq: 1,
      content: "Finishing up",
      reason: "upstream error",
    };

    const { container } = render(<StatusBlock block={block} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("block registry meta-block wiring", () => {
  it("dispatches follow_ups / clarification / status via renderBlock", () => {
    // Testing-library is not configured with auto-cleanup in this
    // workspace (vitest ``globals: false`` + no setup file), so we
    // scope every DOM query to the returned ``container`` rather
    // than ``screen`` to avoid cross-test leakage.
    const followUps: Block = {
      id: "fu",
      type: "follow_ups",
      state: "ready",
      seq: 0,
      items: [{ text: "continue" }],
    };
    const clarification: Block = {
      id: "cl",
      type: "clarification",
      state: "ready",
      seq: 0,
      content: "which one?",
    };
    const status: Block = {
      id: "st",
      type: "status",
      state: "partial",
      seq: 1,
      content: "Checking sources",
    };

    const { container } = render(
      <BlockContextProvider sources={[]} mentionedPeople={[]}>
        {renderBlock(followUps)}
        {renderBlock(clarification)}
        {renderBlock(status)}
      </BlockContextProvider>,
    );

    const followUpsMarker = container.querySelector(
      '[data-slot="follow-ups-block"]',
    );
    expect(followUpsMarker).toBeTruthy();
    expect(followUpsMarker?.textContent).toContain("continue");

    const clarificationCard = container.querySelector(
      '[data-slot="clarification-block"]',
    );
    expect(clarificationCard?.textContent).toContain("which one?");

    const statusEl = container.querySelector('[data-slot="status-block"]');
    expect(statusEl?.textContent).toContain("Checking sources");
  });
});
