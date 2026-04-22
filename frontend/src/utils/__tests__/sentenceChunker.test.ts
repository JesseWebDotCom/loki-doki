import { describe, expect, it } from 'vitest';

import { createSentenceChunker } from '../sentenceChunker';

describe('createSentenceChunker', () => {
  it('emits a single sentence from one push', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('Hello there.')).toEqual([
      { text: 'Hello there.', spokenText: 'Hello there.', index: 0 },
    ]);
  });

  it('emits a split sentence across multiple pushes', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('Hel')).toEqual([]);
    expect(chunker.push('lo the')).toEqual([]);
    expect(chunker.push('re. ')).toEqual([
      { text: 'Hello there.', spokenText: 'Hello there.', index: 0 },
    ]);
  });

  it('emits multiple sentences from one push', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('First. Second? Third!')).toEqual([
      { text: 'First.', spokenText: 'First.', index: 0 },
      { text: 'Second?', spokenText: 'Second?', index: 1 },
      { text: 'Third!', spokenText: 'Third!', index: 2 },
    ]);
    expect(chunker.flush()).toEqual([]);
  });

  it('strips citations and markdown in spoken text', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('# **Hello** [src:2]\n')).toEqual([]);
    expect(chunker.push('- `friend` [3].')).toEqual([
      {
        text: '# **Hello** [src:2]\n- `friend` [3].',
        spokenText: 'Hello friend.',
        index: 0,
      },
    ]);
  });

  it('suppresses fenced code blocks entirely', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('Before.\n```ts\nconst x = 1;\n')).toEqual([
      { text: 'Before.', spokenText: 'Before.', index: 0 },
    ]);
    expect(chunker.push('console.log(x)\n```\nAfter.')).toEqual([
      { text: '\nAfter.', spokenText: 'After.', index: 1 },
    ]);
    expect(chunker.flush()).toEqual([]);
  });

  it('uses clause fallback on long run-on text', () => {
    const chunker = createSentenceChunker();
    const longLead =
      'This keeps going long enough to require the clause fallback because the summary keeps growing without a terminal mark and should split naturally,';
    expect(chunker.push(`${longLead} and then continues`)).toEqual([
      {
        text: longLead,
        spokenText: longLead,
        index: 0,
      },
    ]);
  });

  it('keeps surrogate pairs intact across pushes', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('Party \uD83C')).toEqual([]);
    expect(chunker.push('\uDF89 time.')).toEqual([
      { text: 'Party 🎉 time.', spokenText: 'Party 🎉 time.', index: 0 },
    ]);
  });

  it('flush emits trailing text without a terminator', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('Trailing fragment')).toEqual([]);
    expect(chunker.flush()).toEqual([
      { text: 'Trailing fragment', spokenText: 'Trailing fragment', index: 0 },
    ]);
  });
});
