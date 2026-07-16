import { expect, test } from 'bun:test'
import { cleanTranscript } from './cleanTranscript'

const cases: Array<[string, string]> = [
  // Leading filler stripped, first letter re-capitalized.
  ['um can you turn on the lights', 'Can you turn on the lights'],
  ['uh what time is it', 'What time is it'],
  // Interior filler removed, meaning intact.
  ['play uh some jazz', 'Play some jazz'],
  ['set a timer for um five minutes', 'Set a timer for five minutes'],
  // False-start word repeat collapsed.
  ['I I want to add milk', 'I want to add milk'],
  ['the the dog is barking', 'The dog is barking'],
  // Multiple issues at once.
  ['um so so what is uh the weather', 'So what is the weather'],
  // Punctuation spacing tidied.
  ['remind me ,  tomorrow', 'Remind me, tomorrow'],
  // Nothing to do -> unchanged (already clean).
  ['turn off the kitchen lights', 'Turn off the kitchen lights'],
  // Conservative: "hmm", "like", "you know" are NOT stripped.
  ['hmm play the next song', 'Hmm play the next song'],
  ['play like the beatles', 'Play like the beatles'],
  // Utterance that is only filler -> falls back to the original trimmed text.
  ['um', 'um'],
  ['  uh   uh  ', 'uh uh'],
  // Empty stays empty.
  ['', ''],
]

test('cleanTranscript removes disfluencies without changing meaning', () => {
  for (const [input, expected] of cases) {
    expect(cleanTranscript(input)).toBe(expected)
  }
})
