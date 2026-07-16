# Wake Word Accuracy: Diagnosis and Design

Date: 2026-07-16. Scope: why locally trained wake words false-trigger, how mature projects avoid it, and what to change. All numbers below were measured on this machine with the repo's own eval harness (`backend/scripts/eval/wakeword-fa-eval.ts`) unless cited otherwise.

## 1. TL;DR

The false triggering is real, measured, and fleet-wide. The trained detector heads false-accept at **25 to 150+ fires per hour** on real-world audio at their shipped thresholds (industry bar: under 1 per hour, openWakeWord targets under 0.5, microWakeWord ships at 0.16). The dominant cause is a training-data gap: our negatives are almost entirely synthetic (Kokoro TTS plus procedural noise), so real household audio is out-of-distribution and the model fires on it. The eval bank proves this directly: for `trained_hey_loki` at threshold 0.5, 36 of 40 false fires come from the real-recordings bank, zero from synthetic speech, noise, or silence.

Two experiments settle the design:

1. The official openWakeWord `hey_jarvis` head (trained on native-runtime embeddings against ~30,000 hours of real negatives) runs on our ort-web pipeline at **92% recall with zero fires on real/speech/noise banks**. The runtime is fine. The premise that native and ort-web embeddings are incompatible ("~25/dim divergence"), which is why the trainer currently drops openWakeWord's real negative feature bank, is wrong.
2. Retraining our own head with that 60k-window real negative bank enabled produces a detector with **0.0 FA/hr on the entire eval bank** (including the real-audio portion that the shipped models fire on every ~10 s) while every positive clip still peaks at 0.87 to 0.99. The fix is data plus calibration, not architecture (section 6).

## 2. Measured evidence

### 2.1 Shipped trained models, repo eval harness (1,015 s negative bank: synthetic speech, near-miss phrases, colored noise, silence, 360 s real MS-SNSD room recordings)

| Model | Config | FA/hr | Recall | Fire sources (speech/near-miss/noise/silence/real) |
|---|---|---|---|---|
| trained_hey_loki_mqwl8glv | browser (hyst 2, th 0.5) | **141.9** | 83% | 0/4/0/0/**36** |
| trained_hey_loki_mqwl8glv | pod (hyst 4, th 0.5) | 46.1 | **8%** | 0/0/0/0/13 |
| trained_hey_daisy_mqwwtwpu | browser (hyst 2, th 0.5) | **149.0** | 92% | 3/0/0/0/**39** |
| trained_hey_sol_mqwx9gpm | browser (hyst 2, th 0.5) | 24.8 | 67% | 2/3/0/0/2 |
| hey_jarvis (official openWakeWord) | browser (hyst 2, th 0.5) | 7.1* | 92%** | 0/**2**/0/0/0 |

\* Both hey_jarvis fires are on the near-miss bank, which contains "hey jarvie" and "hey harvest", the exact adversarial phrases for that model. Zero fires on real room audio in 6 minutes.
\*\* Measured separately with the correct phrase ("hey jarvis"); the harness derives "hey" from the id `hey_jarvis` and reports a bogus 0% recall (eval bug, section 5.9).

Threshold sweeps found **no operating point** for any trained model that meets 1 FA/hr with recall at or above 75%. For hey_loki even threshold 0.70 at hysteresis 2 still measures 88.7 FA/hr, with recall already down to 67%. The eval's own verdict: "model needs retraining".

Note on the checked-in baseline (`backend/scripts/eval/README.md`, 2026-07-01): it recorded 44 FA/hr browser / 22 FA/hr pod for the same hey_loki model, with fires dominated by the near-miss bank. That bank predates the real MS-SNSD category; once real room audio is in the bank (this run), the measured rate triples and the fire source shifts decisively to real-world audio. The near-miss problem the baseline flagged is still present (4 fires) but is secondary.

Two structural observations from the same table:

- **Browser (hysteresis 2) surfaces the FA problem; pods (hysteresis 4) mask it by destroying recall** (8 to 17% on trained models). Satellites are simultaneously deaf and still false-firing.
- The newest server-trained generation (`mr9*` ids in `trained-manifest.json`) shipped at even lower thresholds, 0.35 to 0.40, which the sweep places at 130 to 266 FA/hr.

### 2.2 The Whisper phrase fallback is very loose

`WhisperWakewordLoop.match()` accepts a window if edit distance is within 30% of the phrase length OR the vowel-free "phonetic skeleton" matches. Replaying the exact matcher over ordinary utterances:

- "hey loki" fires on: "hey look at this", "hey look", "that guy loki from the movie"
- "hey sol" fires on: "hey hold on", "hey you okay", "hey so what do you think", "hey no way"
- "hey bo" fires on: "hey you okay", "hey leo", "hey so what do you think", "hey no way"
- "hey nova" fires on: "hey no way"; "hey willow" fires on "hey wilma", "hey milo come here boy"

Any TV dialog or family conversation containing "hey <anything short>" is a live false-trigger source whenever this path is active. It is active whenever a character has a phrase and no usable trained model, including the silent fallback when the model registry fetch fails, and it also fires on **partial** transcripts (unstable hypotheses).

### 2.3 What was ruled out (tested, negative results)

- **Post-reply stale-buffer re-trigger**: the browser loop resumes after a reply with the wake phrase still in its raw/embedding buffers (the pod path resets, the browser path does not). Reproduced the exact resume sequence against the real detector: scores drop to zero immediately, no re-fire. Not a cause (still worth aligning with the pod's reset for hygiene).
- **Noise/silence firing** ("1.0 on silence" class of bugs): the colored-noise and silence negatives in the current trainer work. Zero fires on those banks for all trained models tested.
- **Runtime pipeline correctness**: the official hey_jarvis model behaves correctly on our ort-web pipeline (92% recall, clean negatives), so mel/embedding/streaming logic is sound.

## 3. How high-accuracy projects do it (research summary)

Full sources: openWakeWord and microWakeWord GitHub docs, ESPHome docs, HA voice blog, Picovoice benchmark, KWS literature. The recipe every serious project converges on:

| Lever | openWakeWord | microWakeWord (HA Voice PE) | Ours today |
|---|---|---|---|
| Positive samples | 100k-200k synthetic TTS clips, dozens of voices | thousands to tens of thousands (Piper) | 168 clips (28 voices x 6 speeds) |
| Real negative data | **~30,000 hours** (ACAV100M, Common Voice, podcasts, FMA music) | FMA + AudioSet + dinner-party corpora | **~35 minutes** (MS-SNSD train split), rest synthetic |
| Hard negatives | Adversarial phonetic neighbors ("hey jealous") in every batch | negative_class_weight 20x, penalty weights | LLM/static near-misses, small volume |
| Augmentation | RIR reverb + noise at 0-30 dB SNR | same + EQ/distortion/SpecAugment | RIR + noise 5-20 dB + pitch/gain (good) |
| Checkpoint selection | vs. millions of negatives | **FA/hr-first**: minimize FA on ambient stream, then accuracy | median val-FP + median recall on synthetic windows |
| Threshold calibration | per-model, FA/hr on held-out DipCo corpus | per-model `probability_cutoff` (e.g. 0.97 quantized) | per-window proxy on 34 min; ships even when the 1 FA/hr target is missed |
| Runtime smoothing | `patience` consecutive frames + debounce | sliding-window average + cutoff | moving avg 4 + hysteresis 2/4 + 1 s refractory (equivalent, fine) |
| VAD gating | built-in `vad_threshold` (Silero) | optional on-device VAD model | **none** on the wake path |
| Self-playback | AEC required (Voice PE has XMOS hardware AEC) | same | browser: AEC + TTS mute (ok); pods: TTS suppression only, no AEC |
| Verification stage | `custom_verifier_models` second-stage per user | n/a (cutoffs tuned high instead) | none |
| Published FA bar | < 0.5 FA/hr | 0.16 FA/hr | measured 24.8 to 149 FA/hr |

Additional literature points used below: Alexa's two-stage detect-then-verify cuts false alarms ~67% at negligible cost; Whisper hallucinates plausible text on silence/noise, so transcript-based wake matching must be VAD-gated and tight; Picovoice's benchmark methodology (compare at fixed FA/hr, never at fixed threshold) is the accepted way to pick operating points.

## 4. Why our models false-fire: root causes, ranked

1. **Negative data distribution gap (primary).** ~35 real minutes vs. tens of synthetic hours. The head learns "reject Kokoro speech, procedural noise, silence" and treats real room audio (babble, announcements, kitchen clatter, far-field speech) as out-of-distribution, firing at 100+ FA/hr on it. Proven by the fire-source split (36/40 from the real bank) and by hey_jarvis's clean behavior on identical audio.
2. **The real negative feature bank was disabled on a false premise.** `train_wakeword.py` drops `--neg-features` in ortweb mode citing a native/ort-web embedding mismatch. The hey_jarvis experiment disproves this (a native-trained head discriminates correctly on ort-web features). The mismatch observed historically almost certainly came from the old per-chunk mel extraction (0.71 cosine, fixed since), not the runtime. We are leaving openWakeWord's curated real-audio negatives (60k windows in the downloaded subset, millions available) unused.
3. **No hard FA acceptance gate at ship time.** `pick_operating_threshold()` targets 1 FA/hr but, when unreachable, ships the best-recall threshold anyway and just logs the measured FA (the trainer's own comment records shipped models at "44-137 FA/hr"). Auto-training (`companionWake.ts`) attaches the result to the character unconditionally. `retrain-fleet-with-eval.ts` gates only vs. the incumbent, so a terrible model beats a slightly worse terrible model.
4. **Calibration measures a different quantity than runtime.** The trainer counts raw per-window threshold crossings (12.5/s proxy); runtime applies 4-frame smoothing plus hysteresis on an 80 ms cadence. The eval harness replays the real runtime logic and gets far worse numbers on the same audio than the trainer's calibration printout. Thresholds must be picked with the stream-replay method (`wakewordEvalCore.countFires`), not window counting.
5. **Whisper phrase fallback matcher** (section 2.2): phonetic-skeleton matching plus 30% edit distance is far too loose, fires on partials, and silently becomes the active detector when the model path degrades.
6. **Surface tuning is inverted.** Browser: hysteresis 2 at threshold ~0.5 (too permissive given current models). Pods: hysteresis 4 (recall 8-17%, users compensate by re-shouting, then get false fires anyway from the 4x mic gain path). Neither point was chosen from a sweep.
7. **No VAD gate on the wake path** in either runtime, even though Silero is already loaded in the browser (barge-in) and on the backend (STT endpointing). openWakeWord ships this as a first-class option; it converts "any noise the head mis-scores" into "only speech-like audio can fire".
8. **Post-fire UX amplifies each FA.** A false fire opens an 8 s wake-word-free continued-conversation window with VAD-triggered capture (up to 3 continuations), so one FA near a TV becomes "it just starts listening and responding" repeatedly.

## 5. Design

Ordered by measured impact per unit of work. P0 items are the fix; P1 hardens; P2 is polish.

### P0.0 Instrument activation provenance first

Before changing behavior, tag every activation with its origin: `onnx-wake`, `whisper-wake`, `barge-in`, `follow-up-vad`, or `manual`, and log the score stream around each fire (the detector already computes it). Today a follow-up VAD continuation is indistinguishable from a wake fire in the user's experience ("it just starts listening"), so without provenance we cannot attribute field reports or verify that any fix moved the needle. Cheap: one field on the existing events plus a ring buffer of recent scores.

### P0.1 Re-enable real negatives in training (the openWakeWord feature bank)

- `wakewordTrainer.ts`: pass `--neg-features <negative_features.npy> --keep-native-bank` (the flag exists; today nothing passes `--neg-features` at all). Make `downloadNegFeatures()` part of the Wake Word Training install (180 MB, one-time) rather than optional.
- Keep the existing synthetic negatives (they solved noise/silence firing) and MS-SNSD mixing.
- **Validated** (section 6): with the bank enabled, the retrained hey_loki measures 0.0 FA/hr across the whole eval bank with 12/12 isolated-positive recall. This one change is most of the fix.

### P0.2 Calibrate thresholds by stream replay, and enforce a hard gate

- Replace `pick_operating_threshold`'s per-window counting with the eval-core method: score the calib audio once, then `countFires(scores, threshold, hysteresis)` per candidate threshold, per surface (hyst 2 and hyst 4), picking the operating point at the FA target. The code already exists in `wakewordEvalCore.ts`; the trainer should import-share it or reimplement the same replay in Python.
- Extend the sweep range downward: the trainer floors at 0.30 and the eval sweep at 0.40, but a bank-trained head's correct operating point measured at 0.20 to 0.30 (section 6, reading 3). Sweep 0.10 to 0.90.
- Score calibration positives in isolation (silence-padded per clip), not as one concatenated stream: concatenation understates recall by ~25 points because the previous utterance stays inside the 2.2 s rolling mel window (section 6, reading 4).
- **Hard gate**: if no threshold meets (FA/hr <= 1 AND recall >= 0.85 on held-out voices), the training FAILS. `companionWake.ts` must not attach a failing model; it should keep the previous model (or the app default) and surface the failure in the admin UI. Never ship "best effort" detectors silently.
- **Be honest about statistical power.** Zero fires over the current 6-minute real bank only bounds FA below ~10/hr; it cannot certify 1/hr, let alone 0.5/hr. Grow the gating corpus toward 20+ hours of real negative audio (the full 34-minute calib split immediately, then podcast/CC-licensed household audio, plus each home's harvested negatives from P1.5) and report the corpus length next to every FA figure. Relabel the manifest/admin-UI "accuracy" field: it is held-out window classification accuracy, not wake accuracy, and 98% of it coexists with 140 FA/hr.
- Store per-surface thresholds: `defaultThreshold` (browser, hyst 2) and a pod threshold picked at hyst 4 from the same sweep, instead of one number used everywhere.

### P0.3 Fix or retire the Whisper phrase fallback matcher

- Drop the phonetic-skeleton OR-branch entirely; it collapses "loki" and "look". Keep fuzzy matching only as edit distance with a much tighter budget (<= 1 edit for phrases under 10 chars, <= 2 under 16), and require the match at utterance start (wake phrases lead commands; matching mid-sentence catches "that guy loki from the movie").
- Never fire from partial transcripts; wait for the final (partials are unstable hypotheses and the latency win is small at 0.8 s silence timeout).
- Make the fallback visible: when hands-free ends up on the phrase path because the trained model failed to load, show it in the UI/console loudly. Today it is a silent downgrade to the weakest detector.

### P0.4 Retrain the fleet under the new gate

- Run `retrain-fleet-with-eval.ts` after P0.1-P0.2 land, keeping its Pareto rule but adding the absolute gate from P0.2 (candidate must itself pass, not merely beat the incumbent).
- Reset the `mr9*` generation thresholds (0.35-0.40) immediately, before retraining, to at least 0.5: per the sweep this halves FA at modest recall cost and is a one-line catalog update.

### P1.1 Second-stage verification (Alexa/openWakeWord pattern)

On every ONNX wake fire, the STT session opens anyway. Use its first final transcript as a free verifier: if the transcript's first ~2 words neither fuzzy-match the phrase (tight budget as in P0.3) nor are empty-with-command-following (run-on case is already captured), cancel the interaction quietly (close capture, no chime-response, return to idle). Amazon reports ~67% false-alarm reduction from this exact pattern; ours costs zero extra model inference since Whisper already ran. Applies to browser and pod paths.

### P1.2 VAD-gate the wake path

- Browser: `WakeWordLoop` already coexists with a loaded Silero stream; require `silero.lastProb >= 0.5` (over the same 80 ms cadence) for a frame to count toward hysteresis. Non-speech transients then cannot accumulate.
- Pod: `WakeDetector` gets the same gate via `backend/src/lib/voice/sileroVad.ts` (already used for STT endpointing). This also neutralizes the 4x `POD_WAKE_GAIN` noise-floor amplification path.

### P1.3 Rebalance pod operating point

With P0 models and per-surface calibrated thresholds, drop pod hysteresis from 4 toward 2-3 chosen by the sweep (the current 4 exists to mask model FA and costs 75-90% recall). Keep the existing post-TTS suppression and `reset()`; add the same reset on the browser loop when it re-enables (hygiene, section 2.3).

### P1.4 Harden the follow-up (wake-word-free) window

One false accept currently buys up to 3 VAD-triggered continuations across 8 s windows (30 s during confirmations), so a single FA near a TV plays out as a whole unwanted conversation. Changes: shorten the default window to 3-4 s; require the follow-up transcript to be plausibly addressed to the companion (non-empty, not matched as media/background by the existing STT no-speech logic) rather than firing on VAD alone; allow one automatic continuation by default instead of three; keep the long confirmation window but make it visually explicit in the HUD. Combined with P0.0 provenance this can be tuned on data rather than feel.

### P1.5 Harvest real false accepts as training negatives

The single practice every project with small data uses (Mycroft `precise-train-incremental`): when a wake fires and the P1.1 verifier rejects it, save the trailing ~3 s of wake audio (already in the detector's raw buffer) to `data/voice/wakewords/hard-negatives/<model>/`. Next retrain mixes these in as negatives with high weight. This closes the loop on each household's actual acoustics (their TV, their kitchen, their voices) with no manual labeling.

### P1.6 Wake-phrase suitability policy

Short companion names ("Bo", "Pip", "Sol", "Lux") are intrinsically weak wake material: few phonemes, many everyday collisions (Picovoice's guidance is 6+ phonemes with diverse sounds). Score phrase suitability at character-creation time (phoneme count, common-word collision check against the near-miss generator) and warn or require a "hey <name>" prefix for weak ones. This bounds the problem before any training happens.

### P2.1 Eval improvements

- Fix the phrase derivation for pretrained ids (`hey_jarvis` currently evaluates recall of "hey").
- Grow the real bank beyond 6 minutes (use the full 34-minute calib split; add a music bank, since FMA-style music negatives are standard and we have none).
- Add a CI-style `bun run eval:wakeword` acceptance run to the fleet retrain, storing per-model score streams (already written to `wake-eval-bank/scores_*.json`) so threshold changes never need re-scoring.

### P2.2 Runtime hygiene

- Browser loop: reset raw/embedding buffers and warmup counter on `setEnabled(true)` (parity with pod `reset()`).
- Cap continued-conversation exposure after a *verified-low-confidence* wake: if the wake fired within 0.02 of threshold, require the wake word again for follow-ups (skip the 8 s free window).
- Seed `wake_word_catalog` rows for the openWakeWord pretrained models so DB-driven thresholds apply to them too.

### Explicitly not proposed

- Switching to microWakeWord/on-device detection (satellites stream to the server by design; server-side openWakeWord-style detection is fine once trained properly).
- Porcupine (closed, per-seat licensing, conflicts with the private/self-hosted principle).
- Rhyme-heavy adversarial negatives beyond the current near-miss volume (openWakeWord's guidance and our own trainer comments both warn they hurt recall when overdone).

## 6. Retrain experiment (validation of P0.1)

Same generated sample set ("hey loki", 28 voices x 6 speeds positives, full negative phrase set, RIR pack, MS-SNSD train negatives), trained twice on this machine, evaluated on the same bank as section 2. Run A is the current pipeline exactly; run B adds `--neg-features negative_features.npy --keep-native-bank` (60,000 real-audio windows from openWakeWord's feature bank, the orphaned code path).

| | Shipped mqwl8glv | Run A (current pipeline) | Run B (+ real negative bank) |
|---|---|---|---|
| Trainer-chosen threshold | 0.47 | 0.35 | 0.38 |
| Trainer's own FA estimate at that threshold | n/a (no real audio at train time) | 7.05/hr (per-window, 34 min) | 1.76/hr (per-window, 34 min) |
| Eval FA/hr at threshold 0.5, hyst 2 | **141.9** | 3.5 | **0.0** |
| Eval FA/hr at trainer's threshold, hyst 2 | ~230 (at 0.47) | 14.2 (at 0.35) | 0.0 (at 0.38) |
| Real-bank fires (of total) | 36/40 | 0 | 0 |
| Best operating point found | none | none meets bar | **th 0.20-0.30, hyst 2: 0.0 FA/hr** |
| Recall, concatenated eval stream | 83% | 58-75% | 75% at th <= 0.30 |
| Recall, isolated clips | not tested | not tested | **12/12** (peaks 0.87-0.99) |
| Negative-bank peaks | real 0.998 | real ~0.5 | speech 0.015, real 0.103, near-miss 0.192 |

Readings:

1. **The real negative bank eliminates the false-accept problem.** Run B's worst negative peak across 17 minutes of bank audio is 0.192 (a near-miss phrase), leaving a wide, clean margin below the weakest positive (0.87).
2. **The shipped fleet trained without real negatives.** Run A (which mixes MS-SNSD) already cuts real-bank fires from 36 to 0 at threshold 0.5; the shipped models' behavior matches a training run where the best-effort noise pack was absent.
3. **The calibrator picks the wrong operating point even for a good model.** Run B's calibrator chose 0.38 (where the concatenated-stream recall is 50%); the correct point, 0.20 to 0.30, is below the sweep floor (`tmin=0.30` in `pick_operating_threshold`, 0.40 in the eval sweep). Per-window FA counting also disagrees with stream replay in both directions (A: 7/hr claimed, 14/hr replayed at 0.35; B: 1.76/hr claimed, 0.0 replayed). Calibration must replay runtime fire logic and sweep the full range.
4. **Recall is now bounded by positives, not the model.** Run B recalls 12/12 isolated positives, including the 1.15x-speed clips outside the trained speed range, but only 9/12 in the eval's concatenated stream (back-to-back utterances leave the previous clip inside the 2.2 s rolling mel window). Real wake usage looks like the isolated case; still, raising positive diversity (more voices or Piper-style multi-speaker generation, speeds past 1.1) is the cheapest recall headroom, and the eval should also score positives in isolation to avoid understating recall.
5. Training cost was unchanged (same machine, same steps); the bank adds one 180 MB download and ~340k negative windows to the classifier stage.

## 7. Rollout

1. Land P0.0 (provenance) immediately so every later change is measurable in the house, not just on the bank.
2. Land P0.1 + P0.2 (trainer changes), retrain and certify "hey loki" as the flagship first, A/B on the eval harness. Only after it demonstrably holds the gate does `retrain-fleet-with-eval.ts` run for the rest.
3. Land P0.3 (matcher) and P1.1 (verifier) in the same release; they cover the transition period while old models are still assigned.
4. P1.2-P1.6 next; measure again with the eval harness plus a week of live provenance-tagged logs from the house.

## 8. Reconciliation with the parallel Codex review

A second review ran in parallel (static analysis only; its checkout lacked the ONNX backbones so it could not execute the harness). Where we agree, independently: training data is orders of magnitude too small, the manifest "accuracy" field is not wake accuracy, calibration must replay the runtime event logic, browser/pod decision profiles must unify, the wake path needs a VAD gate and a second-stage verifier, the Whisper fuzzy path is unfit for always-on use, and the follow-up window is a separate activation source that needs its own policy and instrumentation (adopted here as P0.0 and P1.4, plus the phrase-suitability policy as P1.6 and the statistical-power caveats in P0.2).

Two of its factual claims are superseded by fresh measurements. First, "most false accepts come from similar-sounding speech": that reads the 2026-07-01 baseline, whose bank had no real-audio category; on the current bank the dominant source is ordinary real-world audio (36 of 40 fires), with near-misses secondary. Second, its implied severity (44 FA/hr) understates the current bank's measurement (141.9 FA/hr at the same settings). It also did not surface the two highest-leverage repo-specific facts: the openWakeWord real negative bank is already downloadable and plumbed into `train_wakeword.py` but orphaned on a disproven runtime-divergence premise (P0.1, validated at 0.0 FA/hr), and the calibrator's sweep floor sits above the correct operating point of a bank-trained model (P0.2).
