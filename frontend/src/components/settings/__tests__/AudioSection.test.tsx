import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import AudioSection from "../AudioSection";

const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("AudioSection", () => {
  it("renders plain-language audio labels and a voice test control", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/v1/settings") && !init?.method) {
        return new Response(
          JSON.stringify({
            admin_prompt: "",
            user_prompt: "",
            piper_voice: "en_US-lessac-medium",
            stt_model: "base",
            read_aloud: true,
            speech_rate: 1,
            sentence_pause: 0.4,
            normalize_text: true,
            relationship_aliases: { mother: ["mom"] },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    render(<AudioSection />);

    await waitFor(() => {
      expect(screen.getByText("Voice")).toBeTruthy();
    });

    expect(screen.getByText("Speech Recognition")).toBeTruthy();
    expect(screen.getByText("Read responses out loud")).toBeTruthy();
    expect(
      screen.getByText("Make spoken replies easier to understand"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test Voice" })).toBeTruthy();
  });
});
