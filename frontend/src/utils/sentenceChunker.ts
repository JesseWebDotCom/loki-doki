export interface Utterance {
  text: string;
  spokenText: string;
  index: number;
}

export interface SentenceChunker {
  push(delta: string): Utterance[];
  flush(): Utterance[];
}

const CLAUSE_FALLBACK_THRESHOLD = 120;

function cleanSpokenText(text: string): string {
  return text
    .replace(/\[src:\d+\]/gi, '')
    .replace(/\[\d+\]/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*]\s+|\d+\.\s+)/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)([^*_]+?)(?<=\S)\1/g, '$2')
    .replace(/`+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isTerminator(char: string): boolean {
  return char === '.' || char === '!' || char === '?';
}

function lastClauseBoundary(text: string): number {
  if (text.length <= CLAUSE_FALLBACK_THRESHOLD) {
    return -1;
  }
  return Math.max(text.lastIndexOf(','), text.lastIndexOf(';'));
}

function appendVisibleText(
  input: string,
  state: { inCodeFence: boolean; pendingTicks: number },
): string {
  let out = '';
  let index = 0;

  const flushTicks = () => {
    if (state.pendingTicks >= 3) {
      state.inCodeFence = !state.inCodeFence;
    } else if (!state.inCodeFence && state.pendingTicks > 0) {
      out += '`'.repeat(state.pendingTicks);
    }
    state.pendingTicks = 0;
  };

  while (index < input.length) {
    const char = input[index];
    if (char === '`') {
      state.pendingTicks += 1;
      index += 1;
      continue;
    }
    flushTicks();
    if (!state.inCodeFence) {
      out += char;
    }
    index += 1;
  }

  return out;
}

export function createSentenceChunker(): SentenceChunker {
  let buffer = '';
  let utteranceIndex = 0;
  const parserState = {
    inCodeFence: false,
    pendingTicks: 0,
  };

  const emitThrough = (endExclusive: number): Utterance | null => {
    const text = buffer.slice(0, endExclusive);
    buffer = buffer.slice(endExclusive);
    const spokenText = cleanSpokenText(text);
    if (!spokenText) {
      return null;
    }
    const utterance: Utterance = {
      text,
      spokenText,
      index: utteranceIndex,
    };
    utteranceIndex += 1;
    return utterance;
  };

  const collect = (): Utterance[] => {
    const utterances: Utterance[] = [];

    while (buffer) {
      let boundary = -1;
      for (let i = 0; i < buffer.length; i += 1) {
        if (!isTerminator(buffer[i])) {
          continue;
        }
        const next = buffer[i + 1];
        if (next == null || /\s/.test(next)) {
          boundary = i + 1;
          break;
        }
      }

      if (boundary < 0) {
        const clauseBoundary = lastClauseBoundary(buffer);
        if (clauseBoundary >= 0) {
          boundary = clauseBoundary + 1;
        }
      }

      if (boundary < 0) {
        break;
      }

      const utterance = emitThrough(boundary);
      if (utterance) {
        utterances.push(utterance);
      }
      buffer = buffer.trimStart();
    }

    return utterances;
  };

  return {
    push(delta: string): Utterance[] {
      if (!delta) {
        return [];
      }
      buffer += appendVisibleText(delta, parserState);
      return collect();
    },

    flush(): Utterance[] {
      if (!parserState.inCodeFence && parserState.pendingTicks > 0) {
        buffer += '`'.repeat(parserState.pendingTicks);
      }
      parserState.pendingTicks = 0;
      const utterances = collect();
      const finalUtterance = emitThrough(buffer.length);
      if (finalUtterance) {
        utterances.push(finalUtterance);
      } else {
        buffer = '';
      }
      return utterances;
    },
  };
}
