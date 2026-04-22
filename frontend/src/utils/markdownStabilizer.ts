/**
 * Stabilize partial streaming markdown for display-only rendering.
 *
 * The returned string may include virtual closing delimiters so
 * ``ReactMarkdown`` doesn't flash raw markdown syntax while a block is
 * still streaming. The source envelope content remains untouched.
 */
export function stabilizeStreamingMarkdown(raw: string): string {
  let stabilized = trimTrailingCitation(raw);
  stabilized = trimTrailingIncompleteLink(stabilized);
  stabilized = closeUnclosedFence(stabilized);
  stabilized = closeUnclosedInlineCode(stabilized);
  stabilized = closeUnclosedBold(stabilized);
  stabilized = closeUnclosedItalic(stabilized);
  stabilized = closeTrailingEmphasisUnderscore(stabilized);
  return stabilized;
}

function trimTrailingCitation(raw: string): string {
  if (raw.endsWith("[")) {
    return raw.slice(0, -1);
  }
  return raw.replace(/\[src:(?:\d+)?$/u, "");
}

function trimTrailingIncompleteLink(raw: string): string {
  const match = raw.match(/\[[^\]]*\]\([^)]*$/u);
  if (!match || match.index === undefined) {
    return raw;
  }
  return raw.slice(0, match.index);
}

function closeUnclosedFence(raw: string): string {
  const fenceCount = raw.match(/```/gu)?.length ?? 0;
  if (fenceCount % 2 === 0) {
    return raw;
  }
  return raw.endsWith("\n") ? `${raw}\`\`\`` : `${raw}\n\`\`\``;
}

function closeUnclosedInlineCode(raw: string): string {
  const withoutFences = stripFencedBlocks(raw);
  const tickCount = withoutFences.match(/`/gu)?.length ?? 0;
  if (tickCount % 2 === 0) {
    return raw;
  }
  return `${raw}\``;
}

function closeUnclosedBold(raw: string): string {
  const withoutCode = stripCodeRanges(raw);
  const boldCount = withoutCode.match(/\*\*/gu)?.length ?? 0;
  if (boldCount % 2 === 0) {
    return raw;
  }
  return `${raw}**`;
}

function closeUnclosedItalic(raw: string): string {
  const withoutCode = stripCodeRanges(raw);
  let italicCount = 0;
  for (let index = 0; index < withoutCode.length; index += 1) {
    if (withoutCode[index] !== "*") {
      continue;
    }
    if (withoutCode[index - 1] === "*" || withoutCode[index + 1] === "*") {
      continue;
    }
    italicCount += 1;
  }
  if (italicCount % 2 === 0) {
    return raw;
  }
  return `${raw}*`;
}

function closeTrailingEmphasisUnderscore(raw: string): string {
  if (!raw.endsWith("_")) {
    return raw;
  }
  const withoutCode = stripCodeRanges(raw);
  const opener = withoutCode.match(/(^|[^\w])_([^\s_][^_\n]*)$/u);
  if (!opener) {
    return raw;
  }
  return `${raw}_`;
}

function stripFencedBlocks(raw: string): string {
  return raw.replace(/```[\s\S]*?```/gu, "");
}

function stripCodeRanges(raw: string): string {
  return stripFencedBlocks(raw).replace(/`[^`\n]*`/gu, "");
}
