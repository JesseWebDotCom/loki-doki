---
title: Image Generation
description: Generating images and video with Stable Diffusion XL.
sidebar:
  order: 2
---

Generation runs locally, with no content filter between you and the model. For adults there are no refusals and no restrictions; for accounts with content filtering enabled, results stay family-friendly. Either way, nothing you create ever leaves your home network.

## Basic Generation

Open the Imaging page, type a description of what you want, and tap **Generate**. The AI will refine your prompt and start generating.

## Prompt Tips

- Describe the subject, style, lighting, and mood: _"a cozy cabin in the woods at sunset, warm lighting, oil painting style"_
- Mention the format if it matters: _"portrait"_, _"landscape"_, _"square"_
- The AI automatically adds quality tags and photo-realistic details. You don't need to include "high quality" or "detailed"

## Styles and LoRAs

LoRAs are style add-ons that change the look of generated images: anime style, specific artists, lighting effects, and so on. Your admin controls which LoRAs are available to you.

Select LoRAs from the picker before generating. Multiple LoRAs can be combined.

## Pipelines

| What to say | What happens |
|---|---|
| Describe an image | Basic generation |
| "Make it a video" | Animates the image (AnimateDiff) |
| "Remove the background" | Background removal (BiRefNet) |
| "Make me 4K" | Hi-res upscale |
| Upload a photo + "put me in..." | Face identity transfer |

## Gallery

All generated images are saved in your gallery. Tap any image to see full details, download it, or use it as a starting point for further edits.
