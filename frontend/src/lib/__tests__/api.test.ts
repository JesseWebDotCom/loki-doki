/**
 * Regression test for the SSE final-chunk bug.
 *
 * Before today's fix in `api.ts`, `sendChatMessage` would split the
 * incoming buffer on `\n\n`, dispatch every complete event, and then
 * THROW AWAY whatever was left in the buffer when the reader closed.
 * The synthesis "done" event arrives in exactly the wrong shape:
 * the server doesn't always send a trailing blank line before the
 * stream ends, so the final event ended up in the leftover buffer
 * and was never delivered. The user saw the streaming text but
 * never the "done" payload (and thus never the assistant turn in
 * the chat history).
 *
 * The fix in `api.ts` (look for "REGRESSION FIX") flushes that
 * leftover via `parseSseEvent` once `done === true`. This test pins
 * the behavior so it can never silently regress again.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { sendChatMessage } from "../api";
import type { PipelineEvent } from "../api-types";
import {
  getConnectivitySnapshot,
  resetConnectivityForTests,
} from "../connectivity";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetConnectivityForTests({ browserOnline: true, backendReachable: true });
  vi.restoreAllMocks();
});

/**
 * Build a fake `Response` whose body streams a fixed list of string
 * chunks via a real ReadableStream. Closing the stream WITHOUT a
 * trailing `\n\n` is the whole point — that's the bug condition.
 */
function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("sendChatMessage SSE parser", () => {
  it("delivers the final synthesis event even with no trailing newline", async () => {
    const finalPayload = {
      phase: "synthesis",
      status: "done",
      data: { response: "FULL" },
    };

    const chunks = [
      // earlier complete event with the standard double-newline terminator
      'data: {"phase":"augmentation","status":"done","data":{}}\n\n',
      // FINAL event arrives WITHOUT a trailing blank line, then the
      // stream closes. Pre-fix this got lost in the leftover buffer.
      `data: ${JSON.stringify(finalPayload)}`,
    ];

    globalThis.fetch = vi.fn(async () => streamingResponse(chunks)) as any;

    const events: PipelineEvent[] = [];
    await sendChatMessage("hi", (e) => events.push(e));

    // The earlier event still flows.
    expect(events.some((e) => e.phase === "augmentation")).toBe(true);

    // And — the regression assertion — the final event MUST be
    // delivered even though it had no trailing "\n\n".
    const finalEvents = events.filter(
      (e) => e.phase === "synthesis" && e.status === "done",
    );
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0].data).toEqual({ response: "FULL" });
  });

  it("handles multiple events split across one chunk", async () => {
    const chunks = [
      'data: {"phase":"a","status":"done","data":{}}\n\n' +
        'data: {"phase":"b","status":"done","data":{}}\n\n',
    ];
    globalThis.fetch = vi.fn(async () => streamingResponse(chunks)) as any;

    const events: PipelineEvent[] = [];
    await sendChatMessage("hi", (e) => events.push(e));

    expect(events.map((e) => e.phase)).toEqual(["a", "b"]);
  });

  it("handles a single event split across two chunks", async () => {
    const chunks = [
      'data: {"phase":"synth',
      'esis","status":"done","data":{"response":"OK"}}\n\n',
    ];
    globalThis.fetch = vi.fn(async () => streamingResponse(chunks)) as any;

    const events: PipelineEvent[] = [];
    await sendChatMessage("hi", (e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0].data.response).toBe("OK");
  });

  it("marks the backend offline when the chat request cannot connect", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as any;

    await expect(sendChatMessage("hi", () => undefined)).rejects.toThrow(
      /Failed to fetch/,
    );
    expect(getConnectivitySnapshot().status).toBe("backend_offline");
  });
});
