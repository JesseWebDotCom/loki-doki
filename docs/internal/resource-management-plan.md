# Resource Management: Approach Review & Plan

Written 2026-07-18, after the one-switch consolidation landed. Charter from Jesse:
**stable and performant, everywhere**. Fast chats, fast web/UI, fast spoken responses,
no system freezes or lags. Leverage CPU appropriately, cache appropriately, manage
VRAM appropriately, handle multi-GPU. One setting: Automatic or Manual, where
Automatic handles everything.

---

## Approach double-check: verdict

The one-switch architecture is sound: a single `resource.mode` (automatic | manual)
gating every placement decision is the right simplification, and enforcement at the
decision points (`getModel()`, sidecar spawn) is the right mechanism. The review
found the design holds, but surfaced two implementation holes (both fixed, see
below), several coherence gaps (Phase 1), and one honest scope limit: what shipped is
**static placement + self-healing on restart**, not yet **dynamic runtime
arbitration**. Phases 2-3 close that.

### What exists today (verified in code, do not rebuild)

| Concern | Where | State |
|---|---|---|
| One Automatic/Manual switch | `lib/resourceMode.ts`, Admin > System > AI engine | Shipped; automatic overrides per-subsystem pins |
| LLM model + ctx fitted to VRAM | `lib/engineAutotune.ts`, `getModel()`/`autotunedNumCtx()` | Shipped; installed-model guard added in review |
| Multi-GPU placement (LLM vs image gen on separate cards) | `lib/hwfit.ts` `resolveGpuPlacement` | Exists; CUDA pin + Vulkan disable, free-VRAM-aware ComfyUI card pick |
| VRAM eviction policy | `models.ts` keep-alive resolver | Exists; chat + embedders pinned resident, others age out |
| Engine guards (parallel, flash attn, q8 KV cache, max loaded) | `lib/engineGuards.ts` | Exists; flash attention + quantized KV on by default |
| Image gen VRAM tiers (lowvram etc.) | `hwfit.getComfyUILaunchConfig` | Exists |
| Video encode hardware pick (NVENC / VideoToolbox / CPU) | `lib/media/encoder.ts` | Exists; probes encoder, falls back to CPU. Automatic by construction |
| Voice compute device auto-detect + CPU fallback | `scripts/voice-server.ts`, `lib/voiceServer.ts` | Shipped this round |
| Ollama hygiene (orphan runner sweeps, restarts) | `lib/ollamaHygiene.ts` | Exists; 60s watchdog |
| Caches (KV warmup prefix, per-conversation memory, router index, pronunciation, installed-models) | various, see `chat-latency.md` | Exists |
| GPU brownout guard (clock caps on the eGPU prod box) | `gpu-power-guard.ps1` | Exists, host-level |

### Holes found in review (fixed immediately, same day)

1. **Automatic could serve a model that is not installed.** The autotune picked from
   the catalog without checking `ollamaList`; a box with only the 12B pulled would
   404 every chat. `getModel()` now validates against the installed list (cached
   60s, tolerant of Ollama being down) and falls back: recommendation ->
   installed pin -> smallest installed chat LLM -> recommendation (fresh install).
2. **Warmup could run before the mode was cached.** `index.ts` fires warmup at
   startup; only `system.ts` boot resolved `resource.mode`, so manual users could
   get the auto pick warmed instead of their pinned model. `_doWarmup` now resolves
   the mode itself first.

---

## The Plan

Principle for every phase: interactive latency wins. Chat and voice are the family's
foreground; image/video/background jobs yield. Never oversubscribe VRAM (WDDM
sysmem spill is the freeze/lag failure mode); prefer CPU for work CPU does well
(voice, endpointing, transcode fallback) so the GPU stays LLM-first.

### Phase 1: coherence + self-healing downloads (small, do next)

1. **UI knobs reflect the mode.** In automatic: the admin model picker
   (ModelCardGroup for llm roles) and the Voice engine device selector render
   disabled with "Managed automatically" and a link to the master switch; the
   Response-speed presets and behaviour toggles stay live (they are preference, not
   placement). Prevents "I changed it and nothing happened".
2. **Self-healing model download.** If the autotune recommendation is not installed,
   automatic currently falls back (correct but slower). Add: queue the recommended
   model via the existing `downloadJobs` infra in the background, then switch on
   completion (the `setModelSettingAndUnloadDisplaced` hook already exists). Boot
   becomes: run with what exists, converge to the ideal.
3. **Displaced-model unload on autotune change.** When the automatic pick changes
   (hardware change, model finished downloading), unload the previously-resident
   chat model so both never sit in VRAM together.
4. **Clamp per-user `ctx_limit` in automatic.** A user pref can currently override
   `autotunedNumCtx()` upward and blow the VRAM budget; in automatic, clamp to the
   fitted value.
5. **Wire `voice.endpoint_silence_ms` + sidecar dtype into the same story** (they
   are performance knobs, not placement; they stay adjustable in both modes but get
   sane automatic defaults).

### Phase 2: stability guardrails (the "no freezes, no lags" phase)

**Landed 2026-07-18:**
- 6. Shared-GPU coordination (`lib/vramLedger.ts` + `runGpuHeavyJob` wrapping heavy
  image/video pipelines) + the automatic `num_ctx` clamp. DONE.
- 7. Spill auto-remediation (`llmStatus.remediateChatSpill`): sustained chat-model
  offload in automatic evicts the resident router to free VRAM. DONE.
- 8. CPU discipline: ffmpeg already runs below-normal priority + `-threads` cap
  (`lib/ffmpeg.ts`, pre-existing); added the p95 web-latency probe (`lib/apiLatency.ts`
  + `/api/*` middleware + `GET /api/admin/gpu/api-latency`, shown in the AI-engine
  card). DONE.
- 9. Multi-GPU verification: confirmed the coding engine (`codingEngine.ts`) reads the
  same `getCachedGpuPlacement()` and pins itself, ComfyUI uses `comfyIndex`, and video
  runs through the deprioritized ffmpeg. Consistent. VERIFIED.

All of Phase 2's stability guardrails are in. Needs on-hardware validation (single-GPU
prod box + a real multi-GPU box) that the evict/re-warm timing and the router-eviction
remediation behave under load.

6. **VRAM ledger + admission control.** One module that knows, per GPU: total,
   used (nvidia-smi), and what WE placed there (LLM, router, embeds, Kokoro, image
   gen). Any subsystem starting GPU work asks the ledger first; if the work does not
   fit, it runs CPU / waits / evicts per policy instead of oversubscribing. This is
   the single mechanism that prevents the WDDM sysmem-spill freeze class.
7. **Spill detection + auto-remediation.** `llmStatus` already computes offloadPct
   per loaded model. In automatic, a chat model observed >0% CPU-offloaded triggers:
   re-run autotune, unload/downshift, log `[resource]`, and surface an admin health
   issue. Closes the loop the static fit can miss (driver overhead drift, other
   apps eating VRAM).
8. **CPU discipline so the web stays fast.** The backend event loop must never be
   starved by inference: voice sidecar and ffmpeg run at below-normal OS priority
   with bounded thread counts (ffmpeg `-threads`, ort intra-op threads); heavy
   Whisper long-form (podcast) jobs run only when no interactive voice session is
   live. Add a p95 API-latency probe to Admin > Troubleshooting so web
   responsiveness is measured, not assumed.
9. **Multi-GPU verification pass.** `hwfit` splits LLM vs image gen; verify voice
   (if ever GPU), video enhance, and the coding engine respect the same placement
   map, and that the ledger (item 6) is per-card.

### Phase 3: dynamic arbitration ("when to switch things around")

**Landed 2026-07-18:** item 11's core (evict-and-restore for image gen) plus the
proactive re-warm (free ComfyUI VRAM then warm the LLM back after a heavy job, so the
next chat isn't cold). DONE. Items 10 (explicit priority ladder) and 12 (genQueue
yield-while-interactive for background jobs like podcast transcription / stems) remain:
they need care to avoid starving background work and are best built + measured on the
box, since the freeze-class problem (image gen vs LLM) is already closed by item 11.

10. **Priority ladder, enforced.** interactive chat/voice > image gen (user is
    waiting, but seconds-scale) > video enhance/transcode > background sweeps
    (memory judge, embeddings, podcast transcription, wakeword training). Ladder
    lives in the ledger module; every GPU/CPU-heavy entry point declares its tier.
11. **Evict-and-restore for burst work on single-GPU boxes.** Image gen on the 8GB
    prod box does not fit beside the LLM. Automatic: pause LLM residency
    (keep_alive 0 + unload), run the generation, re-warm the LLM immediately after
    (warmup path already exists). User-visible rule: a chat sent mid-generation
    queues and answers a few seconds later, never OOMs, never freezes the box.
12. **Background-job scheduler awareness.** `genQueue`/`downloadJobs` gain a "yield
    while interactive" flag for GPU-heavy job types, so a podcast ad-scan or stems
    split never competes with a live conversation.

### Phase 4: verify on real hardware

13. Baseline + after numbers on the prod Windows/eGPU box AND the dev Mac:
    `[CHAT-TIMING]` first-token, `[VOICE-TIMING]` voice-to-voice, p95 API latency,
    image-gen wall time, and "% on GPU" for every resident model. One admin
    dashboard card showing the current placement map (what is where, and why) so
    drift is visible at a glance.

### Non-goals

- Live migration of an in-flight generation between devices.
- Per-request GPU scheduling below Ollama/ComfyUI granularity.
- Managing GPUs the app does not own (display compositor, games).

## Rollout order

Phase 1 items 1-3 first (small, closes the confusing edges), then Phase 2 item 6-7
(the ledger is the keystone; everything in Phase 3 depends on it), then 8, then
Phase 3, with Phase 4 measurement gating each step. Each phase lands independently
behind the existing Automatic mode; Manual mode never changes behavior.
