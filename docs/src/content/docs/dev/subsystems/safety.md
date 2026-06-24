---
title: Security & Safety
description: CSAM image/video defenses, the IRREDUCIBLE_CORE text floor, consent gating, and the honest limits of each control.
sidebar:
  order: 20
---

This page records the safety posture of the project: what we protect against, how, and —
just as importantly — the honest limits of each control. It is the reference for anyone
changing safety-relevant code, so the rationale isn't lost and isn't accidentally undone.

## Posture in one paragraph

This is a self-hosted, single-owner system. The operator is an adult with full control of
the box, so the design favors **autonomy**: nearly everything is dialable, and the
"No Restrictions" content profile opens every content category. Safety is **defense in
depth aimed at preventing casual/accidental and obviously-illegal output**, not an
unbeatable filter. The operator can always edit the code; we do not pretend otherwise.
What we will not do is ship a one-click affordance to bypass the two non-negotiable limits.

## The two non-negotiable limits (`IRREDUCIBLE_CORE`)

Everything else is a dial. These two are not, on any profile including "No Restrictions":

1. **No sexual content involving minors (CSAM).** Illegal essentially everywhere,
   including fictional/drawn/AI-generated depictions; there is no consenting party.
2. **No mass-casualty CBRN weapon instructions** (recipes/quantities for chemical,
   biological, nuclear, radiological weapons designed to kill many people).

Both are about **third parties who cannot consent**, which is why they sit outside the
autonomy model. The asymmetry of error costs governs every design choice below: a false
positive is a recoverable annoyance; a false negative here is irreversible harm.

- Canonical text: `backend/src/lib/safety/textFloor.ts` (`IRREDUCIBLE_CORE`).
- Re-exported by `backend/src/lib/contentPolicy.ts` for the companion path.

## Text safety floor (CBRN + minors, for generated text)

`IRREDUCIBLE_CORE` is injected at the **LLM wrapper** — `applyTextFloor()` inside
`ollamaChat` / `ollamaChatStream` (`backend/src/llm/ollama.ts`). This covers **every**
non-vision text path from one chokepoint (longform, podcast scripts, RAG answers,
web-research lookups, classifiers, etc.) rather than 24 hand-edited prompts.

- Vision calls (messages carrying images) are skipped — the floor is about generated
  text, and we don't pollute classifier prompts.
- The companion path already builds the floor in via `buildContentPrompt`; a marker
  substring prevents double-injection.
- **Limit:** this is an instruction to a cooperative model, not a hard filter.

## Image / video CSAM defense (`backend/src/lib/safety/csamGuard.ts`)

A diffusion model cannot be "instructed" out of CSAM, so we screen **inputs and outputs**
directly. The module is the single reusable component; every image/video surface calls it.

### `screenPrompt(text)` — deterministic, free, always-on

Synchronous age×sexual term-intersection + standalone-term blocklist, with
separator-evasion normalization and sub-18 numeric-age detection. Runs at submit **before
any GPU work**, returns `403`, and is **NOT bypassable** by the `uncensored` consent.

- **Limit:** evadable by avoiding tokens; that's why output screening exists.

### `screenImage(base64)` — VLM classifier, two-flag

One CPU VLM pass (`num_gpu:0`, never competes with the GPU job). Requires **two
independent flags** before reporting `flagged`, so a single hallucination doesn't block a
legitimate image. The second pass only runs on the rare flagged case (no normal-path cost).

The classifier judges **developmental maturity, not body size**, and the rules are
deliberately worded to resist the known failure modes:

- **Little people are adults.** Short stature / dwarfism / petite is explicitly *not*
  evidence of a minor. The discriminator is the **face** (and, when the face is hidden,
  body proportions / head-to-body ratio / secondary sexual characteristics) — never size.
- **The "little person" exception is face-gated and label-immune.** It applies only to an
  **adult face on a small body**. A **child's face is flagged regardless** of body size,
  art style, or any "little person / dwarf / adult" framing. This closes the jailbreak of
  *claiming* a subject is a little person to launder CSAM.
- **The classifier never sees the prompt/label** — only the pixels — so a prompt claim
  cannot tell it what to conclude.
- **Child-face prompt cues** (`childlike`, `babyface`, …) are in the age list, so steering
  a model toward child features trips `screenPrompt` even under a "little person" framing.
- **Limit:** rests on the VLM distinguishing an adult-dwarfism face from a child's face;
  **stylized/anime art** (which flattens age cues) is the genuine weak spot in both
  directions. Use a capable vision model.

### Where the screens are wired

- **Submit prompt floor** — `/api/image/generate` (txt2img + txt2video).
- **i2v input** — the supplied source photo is screened (fail-closed on flag, open on
  classifier error so a down VLM doesn't break the feature).
- **Transform-toward-minor submit rule** — input image (`refId`/`imageBase64`) + a minor
  cue in the prompt ⇒ `403`. Catches "upload adult, make it a child" and
  face-swap-toward-child, where the sexual signal is in the image and the minor signal is
  in the prompt.
- **Output backstop** (inside the shared `makeComfyRun` runner) — screens the **final
  image before it is persisted**, fails closed. Risk-gated: face swaps (`face_id`,
  `face_inpaint`) always; `txt2img` only when the prompt has a minor cue. This is the only
  layer that sees the *result*, so it catches adult→child, face swaps, hidden-face bodies,
  and mislabeled LoRAs — via any route that uses the runner. (Video/i2v outputs are
  animations, not screenable stills; i2v is covered by its input screen instead.)
- **Preview abort** — the mid-generation preview checker screens first and **fails closed**
  (`{blocked:true}`), and the client cancels the job (~30% in) instead of correcting.
- **Uploads** — `vision /analyze`, `home /devices/:id/identify`, and uploaded `image /edit`
  inputs are screened before the VLM/edit touches them.

### No override on the CSAM verdict — by design

There is intentionally **no "generate anyway" button** for a CSAM flag. An override turns
the one non-dialable limit back into a dial. The error costs are asymmetric, so we manage
false positives with **precision** (conservative classifier, two-flag confirm, easy retry
with a different image/prompt/seed) — not a bypass. General adult-content screens and the
connectivity/uncensored consents *do* allow overrides, because those are about the
operator's own autonomy. This one is different in kind.

### LoRAs: enforce at the output, not the label

We do **not** hard-block LoRA imports on minor-term text matching: a LoRA's name/metadata is
uncorrelated with its training data (false positives *and* false negatives). The LoRA vector
is covered **LoRA-agnostically** by `screenPrompt` (submit) and `screenImage` (output).
Civitai's `nsfw`/tags are a useful *categorization prior* (better than keyword-scanning the
name) but cannot be the CSAM gate — they only exist for Civitai imports and describe the
model, not its output.

## Consent (`backend/src/lib/consent.ts`)

Explicit, revocable consent for capabilities that carry real-world risk, collected at first
run (setup wizard) and editable in Admin → Security → Consent. Each consent **gates by
propagating to the existing enforcement prefs**, so withholding it leaves the safe default:

| Consent | Off behavior | Enforced via |
| --- | --- | --- |
| `uncensored` | Censored image generation | `uncensored_images` pref |
| `internet` | Offline-only; net tools blocked | `connectivity.mode` pref |
| `companions` | Companions disabled | `companionsAllowed()` gate in the companion turn |
| `liability` | Use-at-your-own-risk waiver (record only) | — |

- Absence of a consent record = a **legacy/pre-wizard install → grandfathered ON**, so
  existing behavior is never silently disabled. Only an explicit `false` gates a feature.
- The two `IRREDUCIBLE_CORE` limits are **never** part of consent and cannot be consented
  away.

## Honest limits (read before "hardening")

- The image classifier has false negatives, worst on stylized art. Two-flag + a capable VLM
  reduce, not eliminate, this.
- Text-side blocklists are evadable; output/pixel screening is the real backstop.
- The operator controls the server and can remove any check. The goal is responsible
  prevention of casual/accidental and obvious abuse — not a guarantee. Do not describe any
  of this as airtight.

## Quick map

| Concern | Code |
| --- | --- |
| Non-negotiable limits (text) | `lib/safety/textFloor.ts`, injected in `llm/ollama.ts` |
| CSAM image/video screens | `lib/safety/csamGuard.ts`; wired in `routes/image.ts`, `routes/vision.ts`, `routes/home.ts` |
| Content profiles / dials | `lib/contentPolicy.ts` |
| Consent | `lib/consent.ts`, `routes/consent.ts`; UI in `SetupWizard.tsx` + `admin/ConsentManager.tsx` |
