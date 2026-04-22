/**
 * Chunk 13 — slash-command parser unit tests.
 *
 * See ``docs/rich-response/chunk-13-mode-selection-frontend.md``.
 */
import { describe, expect, it } from "vitest";
import { parseSlash, SLASH_PREFIXES } from "../SlashCommandParser";

describe("parseSlash — recognized commands", () => {
  it("parses /deep with a body", () => {
    const result = parseSlash("/deep tell me about quantum tunneling");
    expect(result.override).toBe("deep");
    expect(result.cleanedInput).toBe("tell me about quantum tunneling");
  });

  it("parses /rich with a body", () => {
    const result = parseSlash("/rich who won the 1985 NBA finals");
    expect(result.override).toBe("rich");
    expect(result.cleanedInput).toBe("who won the 1985 NBA finals");
  });

  it("parses /search with a body", () => {
    const result = parseSlash("/search LokiDoki bootstrap wizard");
    expect(result.override).toBe("search");
    expect(result.cleanedInput).toBe("LokiDoki bootstrap wizard");
  });

  it("parses /direct with a body", () => {
    const result = parseSlash("/direct what time is it");
    expect(result.override).toBe("direct");
    expect(result.cleanedInput).toBe("what time is it");
  });

  it("parses /standard with a body", () => {
    const result = parseSlash("/standard summarize this page");
    expect(result.override).toBe("standard");
    expect(result.cleanedInput).toBe("summarize this page");
  });

  it("is case-insensitive on the prefix", () => {
    expect(parseSlash("/Deep hello").override).toBe("deep");
    expect(parseSlash("/DEEP hello").override).toBe("deep");
    expect(parseSlash("/Search fiber optics").override).toBe("search");
  });

  it("ignores leading whitespace before the prefix", () => {
    const result = parseSlash("   /deep explain fusion");
    expect(result.override).toBe("deep");
    expect(result.cleanedInput).toBe("explain fusion");
  });

  it("preserves the body verbatim including internal spaces", () => {
    const result = parseSlash("/rich   padded   body  ");
    expect(result.override).toBe("rich");
    // We strip the one-space separator between prefix and body, but
    // everything else is user text — including trailing spaces.
    expect(result.cleanedInput).toBe("  padded   body  ");
  });
});

describe("parseSlash — pass-through (non-command) inputs", () => {
  it("returns null override for empty string", () => {
    expect(parseSlash("")).toEqual({ override: null, cleanedInput: "" });
  });

  it("returns null override for plain prose", () => {
    const result = parseSlash("what about deep learning?");
    expect(result.override).toBeNull();
    expect(result.cleanedInput).toBe("what about deep learning?");
  });

  it("passes through /tmp and other unrecognized slashes", () => {
    const result = parseSlash("/tmp move the file");
    expect(result.override).toBeNull();
    expect(result.cleanedInput).toBe("/tmp move the file");
  });

  it("passes through a slash command lookalike in the middle of text", () => {
    const result = parseSlash("remind me about /deep work later");
    expect(result.override).toBeNull();
    expect(result.cleanedInput).toBe("remind me about /deep work later");
  });

  it("does not match /deeper as /deep", () => {
    const result = parseSlash("/deeper into the code");
    expect(result.override).toBeNull();
    expect(result.cleanedInput).toBe("/deeper into the code");
  });

  it("does not match a bare prefix with no body", () => {
    const result = parseSlash("/deep");
    expect(result.override).toBeNull();
    expect(result.cleanedInput).toBe("/deep");
  });

  it("does not match a prefix with only trailing whitespace", () => {
    const result = parseSlash("/deep   ");
    expect(result.override).toBeNull();
    expect(result.cleanedInput).toBe("/deep   ");
  });

  it("does not match a prefix followed by a non-space character", () => {
    // ``/deep:hello`` would indicate some other command syntax we don't
    // support — treat as unknown rather than silently eating "/deep:".
    const result = parseSlash("/deep:hello");
    expect(result.override).toBeNull();
    expect(result.cleanedInput).toBe("/deep:hello");
  });

  it("does not treat /artifact as a user-typeable mode", () => {
    const result = parseSlash("/artifact build me a chart");
    expect(result.override).toBeNull();
    expect(result.cleanedInput).toBe("/artifact build me a chart");
  });
});

describe("SLASH_PREFIXES", () => {
  it("exposes all user-typeable modes", () => {
    const modes = [...new Set(SLASH_PREFIXES.map((p) => p.mode))].sort();
    expect(modes).toEqual(["deep", "direct", "rich", "search", "standard"]);
  });

  it("exposes /simple as an alias for the standard mode", () => {
    const simple = SLASH_PREFIXES.find((p) => p.slash === "/simple");
    expect(simple?.mode).toBe("standard");
  });
});
