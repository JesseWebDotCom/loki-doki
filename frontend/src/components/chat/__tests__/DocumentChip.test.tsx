/**
 * Chunk 17 — DocumentChip tests.
 *
 * Pins the chip's public behavior:
 *
 *   * Label text flips with ``mode`` ("Reading full document" for
 *     inline, "Searching document" for retrieval).
 *   * ``data-document-mode`` mirrors the prop so history replay
 *     and e2e assertions can key off the attribute.
 *   * ``MessageItem`` mounts the chip ONLY when
 *     ``envelope.document_mode`` is set; absent / undefined keeps the
 *     shell clean.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import DocumentChip from "../DocumentChip";
import MessageItem from "../MessageItem";
import type { ResponseEnvelope } from "../../../lib/response-types";

afterEach(() => {
  cleanup();
});

function baseEnvelope(overrides: Partial<ResponseEnvelope> = {}): ResponseEnvelope {
  return {
    request_id: "req-doc-test",
    mode: "standard",
    status: "complete",
    blocks: [
      {
        id: "summary",
        type: "summary",
        state: "ready",
        seq: 0,
        content: "Answer built from attached document.",
      },
    ],
    source_surface: [],
    ...overrides,
  };
}

describe("DocumentChip", () => {
  it("renders the inline label and tooltip attributes", () => {
    const { container } = render(<DocumentChip mode="inline" />);
    const chip = container.querySelector('[data-slot="document-chip"]');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("data-document-mode")).toBe("inline");
    expect(chip?.textContent).toContain("Reading full document");
    expect(chip?.getAttribute("role")).toBe("status");
  });

  it("renders the retrieval label when mode is retrieval", () => {
    const { container } = render(<DocumentChip mode="retrieval" />);
    const chip = container.querySelector('[data-slot="document-chip"]');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("data-document-mode")).toBe("retrieval");
    expect(chip?.textContent).toContain("Searching document");
  });
});

describe("MessageItem document_mode wiring", () => {
  it("mounts DocumentChip for inline", () => {
    const { container } = render(
      <MessageItem
        role="assistant"
        content="Answer from the full doc."
        timestamp="2026-04-21T12:00:00Z"
        envelope={baseEnvelope({ document_mode: "inline" })}
      />,
    );
    const chip = container.querySelector('[data-slot="document-chip"]');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("data-document-mode")).toBe("inline");
  });

  it("mounts DocumentChip for retrieval", () => {
    const { container } = render(
      <MessageItem
        role="assistant"
        content="Answer from retrieved passages."
        timestamp="2026-04-21T12:00:00Z"
        envelope={baseEnvelope({ document_mode: "retrieval" })}
      />,
    );
    const chip = container.querySelector('[data-slot="document-chip"]');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("data-document-mode")).toBe("retrieval");
  });

  it("omits DocumentChip when envelope.document_mode is undefined", () => {
    const { container } = render(
      <MessageItem
        role="assistant"
        content="Answer without an attachment."
        timestamp="2026-04-21T12:00:00Z"
        envelope={baseEnvelope()}
      />,
    );
    expect(
      container.querySelector('[data-slot="document-chip"]'),
    ).toBeNull();
  });
});
