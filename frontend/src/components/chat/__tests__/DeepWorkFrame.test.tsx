/**
 * Chunk 18 — DeepWorkFrame tests.
 *
 * The frame is a progress-oriented wrapper around the shared block
 * registry — it does NOT render blocks itself. These tests pin:
 *
 *   * Stage derivation: each stage flips to ``done`` / ``active`` in
 *     response to envelope state, not to a bespoke event channel.
 *   * Mount/unmount path through ``MessageItem``: the frame is only
 *     mounted when ``envelope.mode === "deep"`` AND
 *     ``envelope.status === "streaming"``. A completed deep turn or
 *     a non-deep envelope renders the block stack directly.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import DeepWorkFrame from "../DeepWorkFrame";
import MessageItem from "../MessageItem";
import type { ResponseEnvelope } from "../../../lib/response-types";

afterEach(() => {
  cleanup();
});

function deepEnvelope(overrides: Partial<ResponseEnvelope> = {}): ResponseEnvelope {
  return {
    request_id: "req-deep-test",
    mode: "deep",
    status: "streaming",
    blocks: [
      {
        id: "summary",
        type: "summary",
        state: "loading",
        seq: 0,
      },
      {
        id: "sources",
        type: "sources",
        state: "loading",
        seq: 0,
      },
    ],
    source_surface: [],
    ...overrides,
  };
}

describe("DeepWorkFrame", () => {
  it("renders the stage strip with every stage visible", () => {
    const { container } = render(
      <DeepWorkFrame envelope={deepEnvelope()}>
        <div data-testid="inner-blocks" />
      </DeepWorkFrame>,
    );

    const stages = container.querySelectorAll('[data-slot="deep-stage"]');
    const ids = Array.from(stages).map((node) => node.getAttribute("data-stage-id"));
    expect(ids).toEqual(["expand", "gather", "summary", "finalize"]);
  });

  it("marks the expand stage active when no evidence has landed yet", () => {
    const { container } = render(
      <DeepWorkFrame envelope={deepEnvelope()}>
        <div />
      </DeepWorkFrame>,
    );
    const expand = container.querySelector('[data-stage-id="expand"]');
    expect(expand?.getAttribute("data-stage-state")).toBe("active");
    expect(expand?.getAttribute("aria-current")).toBe("step");
  });

  it("marks gather active once sources are on the surface", () => {
    const envelope = deepEnvelope({
      source_surface: [{ title: "src", url: "https://example.test/a" }],
    });
    const { container } = render(
      <DeepWorkFrame envelope={envelope}>
        <div />
      </DeepWorkFrame>,
    );
    expect(
      container
        .querySelector('[data-stage-id="gather"]')
        ?.getAttribute("data-stage-state"),
    ).toBe("done");
    // summary/finalize have not landed yet — summary is next.
    expect(
      container
        .querySelector('[data-stage-id="summary"]')
        ?.getAttribute("data-stage-state"),
    ).toBe("active");
  });

  it("marks every stage done when the envelope is complete", () => {
    const envelope = deepEnvelope({
      status: "complete",
      blocks: [
        {
          id: "summary",
          type: "summary",
          state: "ready",
          seq: 1,
          content: "Full synthesis.",
        },
        {
          id: "key_facts",
          type: "key_facts",
          state: "ready",
          seq: 0,
          items: [{ text: "a fact" }],
        },
      ],
    });
    const { container } = render(
      <DeepWorkFrame envelope={envelope}>
        <div />
      </DeepWorkFrame>,
    );
    const stages = container.querySelectorAll('[data-slot="deep-stage"]');
    const states = Array.from(stages).map((n) => n.getAttribute("data-stage-state"));
    expect(states).toEqual(["done", "done", "done", "done"]);
  });

  it("renders children inside the frame content slot", () => {
    const { container, getByTestId } = render(
      <DeepWorkFrame envelope={deepEnvelope()}>
        <div data-testid="inner-blocks">child</div>
      </DeepWorkFrame>,
    );
    const content = container.querySelector('[data-slot="deep-stage-content"]');
    expect(content).toBeTruthy();
    expect(getByTestId("inner-blocks")).toBeTruthy();
  });
});

describe("MessageItem deep-mode wiring", () => {
  it("mounts DeepWorkFrame for a streaming deep envelope", () => {
    const { container } = render(
      <MessageItem
        role="assistant"
        content=""
        timestamp="2026-04-21T12:00:00Z"
        envelope={deepEnvelope()}
      />,
    );
    expect(
      container.querySelector('[data-slot="deep-work-frame"]'),
    ).toBeTruthy();
  });

  it("omits DeepWorkFrame once the deep turn completes", () => {
    const { container } = render(
      <MessageItem
        role="assistant"
        content="Final deep summary."
        timestamp="2026-04-21T12:00:00Z"
        envelope={deepEnvelope({
          status: "complete",
          blocks: [
            {
              id: "summary",
              type: "summary",
              state: "ready",
              seq: 1,
              content: "Final deep summary.",
            },
          ],
        })}
      />,
    );
    expect(
      container.querySelector('[data-slot="deep-work-frame"]'),
    ).toBeNull();
  });

  it("omits DeepWorkFrame for non-deep envelopes", () => {
    const { container } = render(
      <MessageItem
        role="assistant"
        content="Regular answer."
        timestamp="2026-04-21T12:00:00Z"
        envelope={{
          request_id: "req-std",
          mode: "standard",
          status: "streaming",
          blocks: [
            {
              id: "summary",
              type: "summary",
              state: "ready",
              seq: 0,
              content: "Regular answer.",
            },
          ],
          source_surface: [],
        }}
      />,
    );
    expect(
      container.querySelector('[data-slot="deep-work-frame"]'),
    ).toBeNull();
  });
});
