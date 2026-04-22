/**
 * Chunk 10 — pure-reducer tests for the rich-response SSE event family.
 *
 * These mirror the backend ordering contract from
 * ``docs/rich-response/chunk-9-response-events.md``:
 *
 *   response_init -> block_init(s) -> block_patch(s) -> block_ready(s)
 *                 -> response_snapshot -> response_done
 *
 * The reducer is a pure function; these tests lock in:
 *
 *   * a full happy-path event sequence produces the expected envelope
 *   * out-of-order seq is idempotent (patches are dropped silently)
 *   * ``response_snapshot`` fully replaces prior delta state
 *   * unknown event phases are a no-op
 *   * ``block_failed`` sets ``state`` + ``reason``
 *   * ``response_done`` carries the final status
 *   * fast-lane turns (no ``response_init``) leave the envelope undefined
 */
import { describe, expect, it } from "vitest";

import type { PipelineEvent } from "../../../lib/api-types";
import {
  RESPONSE_INIT,
  BLOCK_INIT,
  BLOCK_PATCH,
  BLOCK_READY,
  BLOCK_FAILED,
  SOURCE_ADD,
  MEDIA_ADD,
  RESPONSE_SNAPSHOT,
  RESPONSE_DONE,
  reduceResponse,
} from "../../../lib/response-reducer";
import type { ResponseEnvelope } from "../../../lib/response-types";

function makeEvent(phase: string, data: Record<string, unknown>): PipelineEvent {
  return { phase, status: "data", data };
}

function runSequence(events: PipelineEvent[]): ResponseEnvelope | undefined {
  let env: ResponseEnvelope | undefined = undefined;
  for (const ev of events) {
    env = reduceResponse(env, ev);
  }
  return env;
}

describe("reduceResponse — happy path", () => {
  it("applies a full init->patches->ready->snapshot->done sequence", () => {
    const events: PipelineEvent[] = [
      makeEvent(RESPONSE_INIT, {
        request_id: "t-1",
        mode: "standard",
        blocks: [
          { id: "summary", type: "summary" },
          { id: "sources", type: "sources" },
        ],
      }),
      makeEvent(BLOCK_INIT, { block_id: "summary", type: "summary", state: "loading" }),
      makeEvent(BLOCK_INIT, { block_id: "sources", type: "sources", state: "loading" }),
      makeEvent(BLOCK_PATCH, { block_id: "summary", seq: 1, delta: "Luke " }),
      makeEvent(BLOCK_PATCH, { block_id: "summary", seq: 2, delta: "is a Jedi." }),
      makeEvent(BLOCK_READY, { block_id: "summary" }),
      makeEvent(SOURCE_ADD, {
        source: { url: "https://example.test/luke", title: "Luke" },
      }),
      makeEvent(BLOCK_PATCH, {
        block_id: "sources",
        seq: 1,
        items_delta: [{ url: "https://example.test/luke", title: "Luke" }],
      }),
      makeEvent(BLOCK_READY, { block_id: "sources" }),
      makeEvent(RESPONSE_SNAPSHOT, {
        envelope: {
          request_id: "t-1",
          mode: "standard",
          status: "complete",
          blocks: [
            {
              id: "summary",
              type: "summary",
              state: "ready",
              seq: 2,
              content: "Luke is a Jedi.",
            },
            {
              id: "sources",
              type: "sources",
              state: "ready",
              seq: 1,
              items: [{ url: "https://example.test/luke", title: "Luke" }],
            },
          ],
          source_surface: [
            { url: "https://example.test/luke", title: "Luke" },
          ],
        },
      }),
      makeEvent(RESPONSE_DONE, { request_id: "t-1", status: "complete" }),
    ];

    const env = runSequence(events);
    expect(env).toBeDefined();
    expect(env!.request_id).toBe("t-1");
    expect(env!.mode).toBe("standard");
    expect(env!.status).toBe("complete");
    expect(env!.blocks).toHaveLength(2);
    const summary = env!.blocks.find((b) => b.id === "summary")!;
    expect(summary.state).toBe("ready");
    expect(summary.content).toBe("Luke is a Jedi.");
    const sources = env!.blocks.find((b) => b.id === "sources")!;
    expect(sources.state).toBe("ready");
    expect(sources.items).toHaveLength(1);
    expect(env!.source_surface).toHaveLength(1);
  });

  it("flips block.state from loading to partial on first patch", () => {
    const events: PipelineEvent[] = [
      makeEvent(RESPONSE_INIT, {
        request_id: "t-2",
        mode: "standard",
        blocks: [{ id: "summary", type: "summary" }],
      }),
      makeEvent(BLOCK_INIT, { block_id: "summary", type: "summary", state: "loading" }),
      makeEvent(BLOCK_PATCH, { block_id: "summary", seq: 1, delta: "Working" }),
    ];
    const env = runSequence(events);
    expect(env!.blocks[0].state).toBe("partial");
    expect(env!.blocks[0].content).toBe("Working");
  });
});

describe("reduceResponse — seq idempotence", () => {
  it("drops a patch whose seq is not strictly greater than the last-applied", () => {
    const events: PipelineEvent[] = [
      makeEvent(RESPONSE_INIT, {
        request_id: "t-3",
        mode: "standard",
        blocks: [{ id: "summary", type: "summary" }],
      }),
      makeEvent(BLOCK_INIT, { block_id: "summary", type: "summary", state: "loading" }),
      makeEvent(BLOCK_PATCH, { block_id: "summary", seq: 1, delta: "A" }),
      makeEvent(BLOCK_PATCH, { block_id: "summary", seq: 2, delta: "B" }),
      // Replays — should NOT double-append.
      makeEvent(BLOCK_PATCH, { block_id: "summary", seq: 1, delta: "A" }),
      makeEvent(BLOCK_PATCH, { block_id: "summary", seq: 2, delta: "B" }),
    ];
    const env = runSequence(events);
    expect(env!.blocks[0].content).toBe("AB");
    expect(env!.blocks[0].seq).toBe(2);
  });
});

describe("reduceResponse — snapshot wins", () => {
  it("replaces prior delta state with the snapshot envelope", () => {
    const events: PipelineEvent[] = [
      makeEvent(RESPONSE_INIT, {
        request_id: "t-4",
        mode: "standard",
        blocks: [{ id: "summary", type: "summary" }],
      }),
      makeEvent(BLOCK_PATCH, { block_id: "summary", seq: 1, delta: "draft" }),
      makeEvent(RESPONSE_SNAPSHOT, {
        envelope: {
          request_id: "t-4",
          mode: "rich",
          status: "complete",
          blocks: [
            {
              id: "summary",
              type: "summary",
              state: "ready",
              seq: 5,
              content: "final answer",
            },
          ],
          source_surface: [],
        },
      }),
    ];
    const env = runSequence(events);
    expect(env!.mode).toBe("rich");
    expect(env!.status).toBe("complete");
    expect(env!.blocks[0].content).toBe("final answer");
  });
});

describe("reduceResponse — failure and misc", () => {
  it("marks a block failed with a reason", () => {
    const events: PipelineEvent[] = [
      makeEvent(RESPONSE_INIT, {
        request_id: "t-5",
        mode: "standard",
        blocks: [{ id: "sources", type: "sources" }],
      }),
      makeEvent(BLOCK_FAILED, { block_id: "sources", reason: "timeout" }),
    ];
    const env = runSequence(events);
    expect(env!.blocks[0].state).toBe("failed");
    expect(env!.blocks[0].reason).toBe("timeout");
  });

  it("is a no-op for unknown event phases", () => {
    const events: PipelineEvent[] = [
      makeEvent(RESPONSE_INIT, {
        request_id: "t-6",
        mode: "standard",
        blocks: [{ id: "summary", type: "summary" }],
      }),
      makeEvent("decomposition", { model: "qwen-fast" }),
      makeEvent("routing", { skills_resolved: 0 }),
      makeEvent("synthesis", { delta: "noise" }),
    ];
    const before = reduceResponse(undefined, events[0])!;
    const after = events
      .slice(1)
      .reduce((acc, ev) => reduceResponse(acc, ev)!, before);
    expect(after).toEqual(before);
  });

  it("appends media via media_add into a media block", () => {
    const events: PipelineEvent[] = [
      makeEvent(RESPONSE_INIT, {
        request_id: "t-7",
        mode: "standard",
        blocks: [{ id: "media", type: "media" }],
      }),
      makeEvent(BLOCK_INIT, { block_id: "media", type: "media", state: "loading" }),
      makeEvent(MEDIA_ADD, {
        media: { kind: "youtube_video", url: "https://yt.test/1" },
      }),
      makeEvent(MEDIA_ADD, {
        media: { kind: "youtube_video", url: "https://yt.test/2" },
      }),
    ];
    const env = runSequence(events);
    const mediaBlock = env!.blocks.find((b) => b.type === "media")!;
    expect(mediaBlock.items).toHaveLength(2);
  });

  it("response_done carries the final status", () => {
    const events: PipelineEvent[] = [
      makeEvent(RESPONSE_INIT, {
        request_id: "t-8",
        mode: "standard",
        blocks: [],
      }),
      makeEvent(RESPONSE_DONE, { request_id: "t-8", status: "failed" }),
    ];
    const env = runSequence(events);
    expect(env!.status).toBe("failed");
  });

  it("fast-lane path: events without response_init leave env undefined", () => {
    // A fast-lane turn emits only the legacy synthesis events and a
    // terminal response_done. With no response_init to bootstrap the
    // envelope, the reducer stays at undefined so the caller can fall
    // back to the legacy client-derived rendering.
    const events: PipelineEvent[] = [
      makeEvent("synthesis", { delta: "42" }),
      makeEvent(RESPONSE_DONE, { request_id: "t-9", status: "complete" }),
    ];
    const env = runSequence(events);
    expect(env).toBeUndefined();
  });
});
