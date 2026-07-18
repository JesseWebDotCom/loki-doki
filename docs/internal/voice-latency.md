# Voice Latency: Audit, Targets & Optimization Plan

Audit date: 2026-07-18. Companion doc to `chat-latency.md` (which covers the text/LLM leg).
This doc covers the full voice loop: end of user speech to first spoken audio, and the plan to
make it feel like a human friend answering.

**Production platform reality check:** prod is a Windows laptop with a desktop RTX 3070 (8 GB)
in a Thunderbolt eGPU enclosure, power-capped by `gpu-power-guard.ps1` (GPU clocks locked,
CPU turbo disabled). The GPU is LLM-first: the 12B Ollama model consumes most of the 8 GB.
Every recommendation below is written for that box first, dev Mac second. Numbers measured on
the dev Mac (including the `chat-latency.md` table) do not transfer; re-measure on prod.

---

## The Target

Human conversational turn gaps are ~200 ms modal, ~240 ms mean for English (Stivers et al.
2009, PNAS). Humans hit that by planning their reply while the other person is still talking.
The machine equivalent is exactly: semantic endpointing + speculative work during the
utterance. Research consensus (2026): **perceived onset of ~300 to 450 ms is credible for a
fully-local cascaded pipeline; 200 ms is not** without a duplex model (Moshi needs 16+ GB
VRAM and would replace our 12B brain with a weaker one; confirmed infeasible on this
hardware). Anything over ~800 ms reads as "delayed" to users.

So the goal: **300 to 500 ms from end-of-speech to first spoken audio** on conversational
turns, and a spoken acknowledgment within that window on tool turns.

---

## Where We Are Today (audited 2026-07-18)

Warm conversational turn, measured from the moment the user stops speaking:

| Stage | Cost | Source |
|---|---|---|
| 1. Silence endpoint wait | 700 to 800 ms | `silenceTimeoutS` 0.7 default (`routes/stt.ts`), 0.8 whisper-wake path |
| 2. Whisper final decode | ~800 ms+ | base.en q8, non-streaming, full-buffer re-decode after endpoint (`voice-server.ts`) |
| 3. LLM first complete sentence | 500 to 1200 ms | 200 to 900 ms first token (dev Mac) + a full sentence, since TTS waits for a terminator |
| 4. Kokoro synth of sentence 1 | ~450 ms | q4 CPU, sentence is the atomic synth unit |
| 5. Hops + playback pre-buffer | ~100 ms | WS/HTTP hops, WAV/PCM decode passes, 50 ms scheduler buffer |

**Total: roughly 2.6 to 3.5 s conversational; 8 to 11 s on tool-routed turns** (tool routing
is 5 to 8 s to first token per `chat-latency.md`).

Stages 1 and 2 are serial dead air: ~1.5 s in which nothing observable happens. That is the
core finding. The output side is already architecturally right: sentence-by-sentence
pipelining, TTS starts on the first completed sentence, models kept warm, 50 ms pre-buffer.

Secondary findings:

- **No end-to-end instrumentation exists.** `[TTS-TIMING]` and `[CHAT-TIMING]` each cover
  their own leg; nothing stamps speech-end to first-audio. We cannot see regressions.
- **ONNX wakeword path clips run-on commands.** On wake, `useHandsFree.ts` opens a fresh STT
  socket with no pre-roll replay (pre-roll is only buffered during reply/capture states), so
  "hey loki, turn off the lights" in one breath can lose the command head. Users repeat
  themselves, which reads as slowness. The whisper-phrase wake path avoids this but pays a
  full extra endpoint cycle to detect the wake word at all.
- **Follow-up turns pay +400 ms** (`TTS_MUTE_GRACE_MS`) of muted mic after each reply.
- **Stale docs misled the audit:** `subsystems.md` says onnxruntime-wasm and port 8091; the
  sidecar actually runs under Node with onnxruntime-node on CPU at port 8092. Comments in
  `whisper.ts` / `sttSession.ts` mention whisper.cpp; the real engine is transformers.js.
  Fix these when touching those files.

---

## The Plan

Ordered by payoff per effort. Phase 0 first so every later change is measurable.

### Phase 0: instrumentation

Add a `[VOICE-TIMING]` line per voice turn stamping: speech-end (VAD offset), final
transcript, LLM first token, first sentence complete, TTS synth done, first audio scheduled.
Wire the same numbers into an Admin > Troubleshooting probe next to the existing chat
benchmark. Everything below gets judged against this.

### Phase 1: code-only wins on the current stack (~1.3 to 1.5 s recovered)

1. **Reuse the streaming partial at finalize (saves ~0.6 to 0.8 s).** We already re-decode
   the growing buffer every 400 ms for partials. At endpoint, the speech region is by
   definition unchanged for the last 700 ms (only silence was appended). If the latest
   partial covered the full speech region, `finalize()` returns it instead of running a
   fresh full decode. Makes stage 2 nearly free with no model change.
2. **Fire the KV prime at wake time (saves ~0.2 to 0.5 s).** `fireKvPrime` /
   `/api/chat/prime` already exist; trigger on wakeword fire so the prompt prefix prefills
   while the user is still speaking.
3. **First-clause TTS flush, first chunk only (saves ~0.2 to 0.4 s on long openers).**
   Clause splitting was removed everywhere for prosody reasons; restore it for only the
   first clause of the first sentence, whole sentences afterward. One prosody seam in
   exchange for audio at LLM-first-clause time.
4. **Feed wake-window pre-roll into the STT socket on ONNX wake.** Buffer the rolling ~1.5 s
   during idle wake-listening too (same mechanism the barge-in path uses) and replay on
   socket open. Fixes clipped commands and the silent retries they cause.
5. **Spoken ack on tool turns.** The moment routing decides it is a tool turn, play a canned
   pre-synthesized ack ("on it", "let me check"). The `status`/`spoken_cue` SSE plumbing and
   the 450 ms persona `directReply` budget already exist; extend the pattern to turn start.
   Purely perceptual, but it is the difference between "working" and "broken" at 8 s.
   Note from the filler-word literature (arXiv 2507.22352): fillers help at multi-second
   delays and are harmful when mistimed. Use them for tool turns only; once conversational
   onset is under ~500 ms, do not add fillers there.

### Phase 2: endpointing + STT engine (~0.6 to 0.9 s more)

6. **Semantic endpointing: Silero + Smart Turn v3 (saves ~0.45 to 0.55 s).** Smart Turn v3
   (pipecat-ai, BSD-2, US origin, Whisper-tiny encoder lineage): 8 MB int8 ONNX, ~12 ms CPU
   inference, explicitly designed to run beside Silero on plain onnxruntime. Runs fine in
   the existing Node sidecar on the CPU EP on both platforms. Pattern: at a candidate
   silence of ~150 to 250 ms, ask Smart Turn whether the turn is complete; finalize
   immediately if yes, fall back to the relaxed timeout if no. Single largest remaining win.
   (LiveKit's turn detector is disqualified: fine-tuned from Qwen2.5, Chinese-origin base.)
7. **Move STT to a native engine, platform-specific:**
   - **Windows prod: whisper.cpp as a sidecar binary.** CUDA is a first-class backend with
     prebuilt Windows zips and a bundled `whisper-server` HTTP server, which slots into our
     existing sidecar-over-localhost pattern (same as kiwix/voice-server). On RTX-class
     cards base.en decodes a short utterance in ~100 to 250 ms. **VRAM caution:** on the
     8 GB card the 12B model leaves little headroom (whisper base ~0.4 GB, small ~0.9 GB).
     If measurement shows contention or sysmem spill, run whisper.cpp on **CPU** instead:
     base.en is ~15x realtime on modern x86 with AVX2 even with turbo disabled, ~200 ms for
     a 3 s utterance, zero GPU contention. Both variants are the same binary and flag.
   - **Dev Mac: same whisper.cpp sidecar with Metal** (base.en RTF ~0.04).
   - **Do not** attempt CUDA inside onnxruntime-node on Windows: the prebuilt binding ships
     CPU + DirectML + experimental WebGPU only; CUDA-in-Node requires an unsupported source
     build. GPU work on Windows goes through native sidecar binaries, full stop.
   - Fastest known non-Python GPU option if we ever need more: NVIDIA Parakeet TDT 0.6B
     ONNX (CC-BY-4.0, more accurate than whisper base.en, ~50 ms per utterance on CUDA),
     but the convenient runtimes (sherpa-onnx) carry a Xiaomi-affiliation policy flag, and
     driving the raw ONNX TDT decoder loop ourselves is real work. Revisit only if
     whisper.cpp proves insufficient.
8. **Speculative LLM generation on the partial transcript.** At the VAD candidate endpoint
   (before Smart Turn even confirms), fire the Ollama request with the current partial;
   abort and re-fire if the final transcript differs. LiveKit ships this as preemptive
   generation; with Ollama it is one extra streamed POST plus an abort. Combined with 6 and
   7, STT and most of LLM first-token time hide inside the endpoint window, which is the
   human trick (plan during the partner's turn) implemented literally.

### Phase 3: TTS acceleration + polish

9. **Kokoro to the GPU on prod, via a native sidecar.** CPU Kokoro q4 (~450 ms/sentence) is
   the floor blocker once Phases 1-2 land. On CUDA, Kokoro-82M runs RTF ~0.03 to 0.05:
   first-sentence synth drops to ~60 to 100 ms, and the model is only ~330 MB of VRAM, the
   one voice model worth GPU residency on the 8 GB card. Routes, in preference order:
   (a) sherpa-onnx Windows CUDA build serving Kokoro (policy flag on the runtime's origin,
   models stay US-origin); (b) onnxruntime DirectML from the existing Node sidecar after
   re-exporting Kokoro at opset 22 (the shipped opset-17 export errors under DML); (c) stay
   CPU on Mac dev where q4 is already acceptable. Measure TTS-vs-LLM-decode overlap: it is
   the only real concurrent-kernel case in the cascade.
   - Rejected alternatives: Supertonic (KR origin, fine policy-wise, much faster, but
     audibly more robotic than Kokoro; keep as a fallback/backchannel voice option);
     Orpheus-3B streaming TTS (US, genuinely streaming, but needs ~8 GB VRAM and a Python
     or DIY serving path: does not fit); NeuTTS Air (Qwen2 backbone, banned).
10. **Trim `TTS_MUTE_GRACE_MS`** from 400 ms toward ~150 ms once echo behavior is verified
    with echo cancellation on, so follow-up turns re-listen faster.
11. **Windows box hygiene** (cheap, do during Phase 2):
    - `OLLAMA_KEEP_ALIVE=-1` so the 12B never cold-unloads (default is 5 min).
    - NVIDIA control panel: CUDA Sysmem Fallback Policy = "Prefer No Sysmem Fallback".
      Silent VRAM spill to system RAM is an order-of-magnitude latency cliff; we want a
      loud failure instead, and a VRAM budget (LLM + Kokoro + optional whisper) that never
      exceeds physical.
    - Consider disabling Hardware-Accelerated GPU Scheduling (HAGS): reports of ~1 GB VRAM
      reclaimed and lower inference-latency variance. Weakly sourced; A/B it on the box.
    - Keep every model resident and pre-warmed (voice-server already warms Kokoro/Whisper;
      extend the habit to whatever replaces them).

---

## Expected End State

| Milestone | Conversational voice-to-voice |
|---|---|
| Today | 2.6 to 3.5 s |
| After Phase 1 (code only) | ~1.2 to 2.0 s |
| After Phase 2 | ~0.5 to 1.0 s |
| After Phase 3 | **~0.3 to 0.6 s**, matching the best documented local pipelines |

Budget at end state: endpoint ~150 to 250 ms (Smart Turn) + STT hidden inside the window
(partial-reuse or ~100 to 200 ms native decode) + LLM first token mostly hidden (speculative
fire + wake-time KV prime) + first TTS chunk ~80 to 150 ms (GPU Kokoro) + 50 ms pre-buffer.
Tool turns stay LLM-bound but get a spoken ack inside the same window.

## What NOT to Do

1. **No CUDA inside onnxruntime-node on Windows.** The binding does not ship it; the source
   build is unsupported. Native sidecar binaries are the GPU path.
2. **No duplex/speech-to-speech models** (Moshi, Sesame CSM). Wrong hardware fit, weaker
   brain, confirmed overkill for this goal.
3. **No conversational fillers once onset is fast.** Evidence says they only help at
   multi-second delays; keep acks for tool turns.
4. **Do not lower the relaxed silence timeout blindly.** The fixed 0.7 s exists to avoid
   cutting users off; it only shrinks safely behind a semantic turn check (Phase 2, item 6).
5. **Do not move more than Kokoro to the 8 GB GPU without measuring.** The 12B model owns
   that card. Whisper goes GPU only if the VRAM math and contention measurements allow.
6. **Keep the Chinese-origin model ban in view when swapping components.** Disqualified
   along the way: LiveKit turn detector (Qwen2.5 base), NeuTTS Air (Qwen2 backbone),
   canary-qwen-2.5b, MeloTTS (ambiguous origin, treat as excluded). sherpa-onnx is a
   runtime, not a model, but carries a Xiaomi-affiliation flag: needs an explicit call
   before adoption.

## Open Items

- Verify Bun-adjacent details on prod: whisper.cpp Windows CUDA zip contents for the current
  release, and whether the eGPU/Thunderbolt hop changes small-batch inference latency
  meaningfully (it should not for inference, but measure).
- Moonshine v2 (US, MIT, true streaming STT, 50 to 150 ms): paper and license confirmed,
  ONNX exports of v2 not yet verified published. Worth a look if whisper.cpp partial-reuse
  proves awkward.
- Kokoro opset-22 re-export for DirectML (route 9b) is unproven; spike before committing.
- `chat-latency.md` observed-performance table is dev-Mac data; re-measure on prod and
  annotate that doc.
