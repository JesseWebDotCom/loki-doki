/**
 * Slash-command parser for the compose bar.
 *
 * Chunk 13 of the rich-response rollout (see
 * ``docs/rich-response/chunk-13-mode-selection-frontend.md``).
 *
 * This is **command parsing**, not intent classification — CLAUDE.md
 * explicitly permits ``startsWith`` command heads. We never regex over
 * the body of the user's message and never try to infer what they
 * meant; we only recognize an explicit leading token of the form
 * ``/<mode> <...rest>``.
 *
 * Unknown slash prefixes pass through unchanged so routine user text
 * like "what about /tmp again?" is not eaten.
 */
export type ResponseMode =
  | "direct"
  | "standard"
  | "rich"
  | "deep"
  | "search"
  | "artifact";

export interface SlashParseResult {
  /** Resolved mode override, or ``null`` when no command prefix matched. */
  override: ResponseMode | null;
  /** User text with the recognized prefix stripped; unchanged on miss. */
  cleanedInput: string;
}

/**
 * Slash prefixes that are accepted. ``artifact`` is NOT a user-typeable
 * mode — chunks 19-20 trigger artifact mode from the adapter layer.
 * Keep this list tight so we don't collide with future meta-commands.
 */
const PREFIXES: readonly { slash: string; mode: ResponseMode }[] = [
  { slash: "/direct", mode: "direct" },
  { slash: "/simple", mode: "standard" },
  { slash: "/standard", mode: "standard" },
  { slash: "/rich", mode: "rich" },
  { slash: "/deep", mode: "deep" },
  { slash: "/search", mode: "search" },
] as const;

/**
 * Parse a compose-bar input string for a leading slash command.
 *
 * Rules:
 *
 *  - Command must be at the very start of the (leading-trimmed) input.
 *  - Prefix match is case-insensitive (``/Deep`` works same as ``/deep``).
 *  - Prefix must be followed by a single ASCII space then at least
 *    one non-space character — ``/deep`` on its own is not a command,
 *    because the user clearly typed a bare slash/identifier with no
 *    prompt to apply the mode to.
 *  - Unknown slashes (``/tmp``, ``/foo``) pass through: ``override``
 *    is ``null`` and ``cleanedInput`` equals the original input.
 */
export function parseSlash(input: string): SlashParseResult {
  if (!input) {
    return { override: null, cleanedInput: input };
  }
  // Only consider leading whitespace on the left edge — everything
  // after the command body stays the user's verbatim text.
  const leadingWhitespaceMatch = input.match(/^\s*/);
  const leadingWhitespace = leadingWhitespaceMatch
    ? leadingWhitespaceMatch[0]
    : "";
  const head = input.slice(leadingWhitespace.length);
  if (!head.startsWith("/")) {
    return { override: null, cleanedInput: input };
  }

  const lowerHead = head.toLowerCase();
  for (const { slash, mode } of PREFIXES) {
    if (!lowerHead.startsWith(slash)) continue;
    const afterPrefix = head.slice(slash.length);
    // Require a space-then-content suffix. Bare ``/deep`` without a
    // following body is not a meaningful command.
    if (afterPrefix.length === 0) {
      continue;
    }
    if (afterPrefix[0] !== " ") {
      // ``/deeper`` should not match ``/deep`` — it's a different token.
      continue;
    }
    const body = afterPrefix.slice(1);
    if (body.trim().length === 0) {
      continue;
    }
    return { override: mode, cleanedInput: body };
  }
  return { override: null, cleanedInput: input };
}

/** Expose the prefix list for tests + the ModeToggle tooltip content. */
export const SLASH_PREFIXES: readonly { slash: string; mode: ResponseMode }[] =
  PREFIXES;
