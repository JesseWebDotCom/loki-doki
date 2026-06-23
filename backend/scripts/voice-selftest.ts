// Voice pipeline self-test — the automated regression gate for the layered rebuild
// (see plans/voice-rebuild.md). Pure functions only; run with:  bun run scripts/voice-selftest.ts
// Exit code 1 on any failure.

import { stripForSpeech } from '../src/lib/voice/speechText'
import { segmentSentences } from '../src/lib/voice/sentenceSegmenter'
import { refineSentence } from '../src/lib/voice/prosodyText'

let pass = 0
let fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) { pass++; }
  else { fail++; console.log(`  FAIL ${label}\n    got:  ${g}\n    want: ${w}`) }
}
function ok(label: string, cond: boolean, detail = '') {
  if (cond) pass++; else { fail++; console.log(`  FAIL ${label} ${detail}`) }
}

console.log('— Layer 1/2: stripForSpeech (content preserved, emotes/markup removed) —')
// <i>/<em> emphasis = real words → KEEP. <action>/*…*/(…)/[…] = stage directions → DROP.
eq('i-unwrap', stripForSpeech("Oh no, that's <i>terrible to hear</i> about it."), "Oh no, that's terrible to hear about it.")
eq('em-unwrap', stripForSpeech('That is <em>so</em> sad.'), 'That is so sad.')
eq('action-drop', stripForSpeech('<action>winks</action> hey there!'), 'hey there!')
eq('asterisk-drop', stripForSpeech('*sigh* I guess so.'), 'I guess so.')
eq('bold-keep', stripForSpeech('This is **important** news.'), 'This is important news.')
eq('paren-drop', stripForSpeech('Sure (smiles) thing.'), 'Sure thing.')
ok('plain-untouched', stripForSpeech('How is it going today?') === 'How is it going today?')
ok('never-empty-when-words', stripForSpeech("Oh no, that's <i>awful</i>").includes('awful'))

console.log('— Layer 1: segmentSentences (splits; soft newline joined; paragraph splits) —')
eq('one-sentence', segmentSentences('How is it going?'), ['How is it going?'])
eq('two-sentences', segmentSentences('Hi there! How are you?'), ['Hi there!', 'How are you?'])
// soft mid-sentence newline must NOT chop (the "a news\nsite?" bug)
eq('soft-newline-join', segmentSentences(stripForSpeech('on a news\nsite?')), ['on a news site?'])
eq('paragraph-split', segmentSentences(stripForSpeech('First point.\n\nSecond point.')), ['First point.', 'Second point.'])

console.log('— Layer 1/3: refineSentence (terminal punctuation, question, pause) —')
eq('aux-question', refineSentence('Are you sure about that').text, 'Are you sure about that?')
eq('wh-not-question', refineSentence('What a great day').text, 'What a great day.')   // exclamation, not Q
eq('ellipsis', refineSentence('Well I am not sure...').text, 'Well I am not sure…')
ok('clause-fragment-kept', refineSentence('Was it on social media,').text === 'Was it on social media,')

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
