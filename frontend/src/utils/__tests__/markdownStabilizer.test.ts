import { describe, expect, it } from "vitest";

import { stabilizeStreamingMarkdown } from "../markdownStabilizer";

describe("stabilizeStreamingMarkdown", () => {
  it("returns closed content verbatim", () => {
    const input = "**Luke** uses `the Force` and [src:1]";
    expect(stabilizeStreamingMarkdown(input)).toBe(input);
  });

  it("virtually closes unclosed bold markers", () => {
    expect(stabilizeStreamingMarkdown("**hello")).toBe("**hello**");
  });

  it("virtually closes unclosed italic markers", () => {
    expect(stabilizeStreamingMarkdown("*em")).toBe("*em*");
  });

  it("virtually closes unclosed inline code", () => {
    expect(stabilizeStreamingMarkdown("`code")).toBe("`code`");
  });

  it("virtually closes an odd fenced code block", () => {
    expect(stabilizeStreamingMarkdown("```\nconst x = 1")).toBe(
      "```\nconst x = 1\n```",
    );
  });

  it("ignores unmatched backticks inside a fenced block", () => {
    expect(stabilizeStreamingMarkdown("```\nconst name = `Luke`\n")).toBe(
      "```\nconst name = `Luke`\n```",
    );
  });

  it("elides a trailing incomplete citation opener", () => {
    expect(stabilizeStreamingMarkdown("See [src:")).toBe("See ");
  });

  it("elides a trailing incomplete citation number", () => {
    expect(stabilizeStreamingMarkdown("See [src:12")).toBe("See ");
  });

  it("preserves a closed citation marker", () => {
    expect(stabilizeStreamingMarkdown("See [src:1]")).toBe("See [src:1]");
  });

  it("elides a trailing incomplete link from the opener onward", () => {
    expect(stabilizeStreamingMarkdown("Luke [Skywalker](ht")).toBe("Luke ");
  });

  it("preserves a closed markdown link", () => {
    const input = "Visit [Luke](https://x)";
    expect(stabilizeStreamingMarkdown(input)).toBe(input);
  });

  it("does not mutate snake_case identifiers", () => {
    expect(stabilizeStreamingMarkdown("foo_bar_baz")).toBe("foo_bar_baz");
  });

  it("is idempotent for representative streaming inputs", () => {
    const inputs = [
      "**hello",
      "*em",
      "`code",
      "```\nconst x = 1",
      "See [src:",
      "Luke [Skywalker](ht",
    ];

    for (const input of inputs) {
      const once = stabilizeStreamingMarkdown(input);
      expect(stabilizeStreamingMarkdown(once)).toBe(once);
    }
  });
});
