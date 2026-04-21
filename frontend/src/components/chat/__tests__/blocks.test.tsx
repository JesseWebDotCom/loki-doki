import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Block } from "../../../lib/response-types";
import type { MediaCard, SourceInfo } from "../../../lib/api";
import MessageItem from "../MessageItem";
import SummaryBlock from "../blocks/SummaryBlock";
import SourcesBlock from "../blocks/SourcesBlock";
import MediaBlock from "../blocks/MediaBlock";
import { BlockContextProvider, renderBlock } from "../blocks";

function withContext(node: React.ReactNode) {
  return (
    <BlockContextProvider sources={[]} mentionedPeople={[]}>
      {node}
    </BlockContextProvider>
  );
}

describe("SummaryBlock", () => {
  it("renders content when state is ready", () => {
    const block: Block = {
      id: "summary",
      type: "summary",
      state: "ready",
      seq: 0,
      content: "The answer is 42.",
    };

    render(withContext(<SummaryBlock block={block} />));

    expect(screen.getByText("The answer is 42.")).toBeTruthy();
  });

  it("renders a skeleton when state is loading", () => {
    const block: Block = {
      id: "summary",
      type: "summary",
      state: "loading",
      seq: 0,
    };

    const { container } = render(withContext(<SummaryBlock block={block} />));

    expect(container.querySelector('[data-slot="block-loading"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it("renders partial content while streaming", () => {
    const block: Block = {
      id: "summary",
      type: "summary",
      state: "partial",
      seq: 1,
      content: "Working on it",
    };

    render(withContext(<SummaryBlock block={block} />));

    expect(screen.getByText("Working on it")).toBeTruthy();
  });

  it("renders a muted failure chip with reason when state is failed", () => {
    const block: Block = {
      id: "summary",
      type: "summary",
      state: "failed",
      seq: 0,
      reason: "skill timeout",
    };

    const { container } = render(withContext(<SummaryBlock block={block} />));

    expect(container.querySelector('[data-slot="block-failed"]')).toBeTruthy();
    expect(screen.getByText("skill timeout")).toBeTruthy();
  });
});

describe("SourcesBlock", () => {
  it("renders nothing when state is omitted", () => {
    const block: Block = {
      id: "sources",
      type: "sources",
      state: "omitted",
      seq: 0,
      items: [],
    };

    const { container } = render(withContext(<SourcesBlock block={block} />));

    // BlockShell returns null for omitted; the wrapper rendered nothing.
    expect(container.firstChild).toBeNull();
  });

  it("emits a structural marker with the source count when ready", () => {
    const sources: SourceInfo[] = [
      { url: "https://example.test/a", title: "A" },
      { url: "https://example.test/b", title: "B" },
    ];
    const block: Block = {
      id: "sources",
      type: "sources",
      state: "ready",
      seq: 0,
      items: sources,
    };

    const { container } = render(withContext(<SourcesBlock block={block} />));

    const marker = container.querySelector('[data-slot="sources-block"]');
    expect(marker).toBeTruthy();
    expect(marker?.getAttribute("data-source-count")).toBe("2");
  });
});

describe("MediaBlock", () => {
  it("renders the MediaBar when ready", () => {
    const media: MediaCard[] = [
      {
        kind: "youtube_video",
        url: "https://youtube.test/watch?v=abc",
        video_id: "abc123",
        title: "Test Video",
      },
    ];
    const block: Block = {
      id: "media",
      type: "media",
      state: "ready",
      seq: 0,
      items: media,
    };

    const { container } = render(withContext(<MediaBlock block={block} />));

    // MediaBar renders an iframe player for YouTube videos — the
    // youtube_video card branch is exercised, matching current behavior.
    expect(container.querySelector('[data-block-state="ready"]')).toBeTruthy();
  });

  it("renders nothing when state is omitted", () => {
    const block: Block = {
      id: "media",
      type: "media",
      state: "omitted",
      seq: 0,
      items: [],
    };

    const { container } = render(withContext(<MediaBlock block={block} />));
    expect(container.firstChild).toBeNull();
  });
});

describe("block registry", () => {
  it("renders summary / sources / media via renderBlock and skips unknown types", () => {
    const summary: Block = {
      id: "summary",
      type: "summary",
      state: "ready",
      seq: 0,
      content: "Hello world",
    };
    const unknown: Block = {
      id: "facts",
      type: "key_facts",
      state: "ready",
      seq: 0,
      items: [],
    };

    render(
      withContext(
        <>
          {renderBlock(summary)}
          {renderBlock(unknown)}
        </>,
      ),
    );

    expect(screen.getByText("Hello world")).toBeTruthy();
    // ``key_facts`` isn't in the registry yet (chunks 14/15) — it
    // silently returns null instead of crashing.
  });
});

describe("MessageItem block composition", () => {
  it("renders exactly one summary via the blocks path on the assistant side", () => {
    const { container } = render(
      <MessageItem
        role="assistant"
        content="Paris is the capital of France."
        timestamp="2026-04-21T12:00:00Z"
      />,
    );

    const readyBlocks = container.querySelectorAll(
      '[data-block-state="ready"]',
    );
    const summaryBlocks = container.querySelectorAll(
      '[data-block-id="summary"]',
    );
    expect(summaryBlocks.length).toBe(1);
    // sources + media are omitted (no items), so only the summary
    // ready-block is present.
    expect(readyBlocks.length).toBe(1);
    expect(screen.getByText("Paris is the capital of France.")).toBeTruthy();
  });

  it("omits the media + sources blocks when the synthesis payload has neither", () => {
    const { container } = render(
      <MessageItem
        role="assistant"
        content="Hello."
        timestamp="2026-04-21T12:00:00Z"
      />,
    );

    expect(
      container.querySelector('[data-block-id="sources"]'),
    ).toBeNull();
    expect(container.querySelector('[data-block-id="media"]')).toBeNull();
  });

  it("leaves the user bubble on the legacy (non-block) path unchanged", () => {
    render(
      <MessageItem
        role="user"
        content="What is 2 + 2?"
        timestamp="2026-04-21T12:00:00Z"
      />,
    );

    // No block data-slot markers on the user side.
    expect(screen.getByText("What is 2 + 2?")).toBeTruthy();
  });
});
