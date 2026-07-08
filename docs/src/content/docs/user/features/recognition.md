---
title: Recognition
description: Show the AI a photo and it tells you what's in it — objects, vehicles, text, the scene, and any safety concerns — all on your own server.
sidebar:
  order: 4.5
---

Recognition lets you hand the AI a picture and ask "what am I looking at?" It reads the photo the way a person would: the overall scene, the things in it, any text or signs, vehicles down to the make and model, and anything that looks like a safety concern. It all runs on a vision model on your own server, so the photo never leaves your hardware.

## Analyzing a Photo

Open the **Recognition** tab in the Images app, drop in a photo, and the AI works through it in a few passes at once. When it's done you get a tidy panel:

- **Scene**: a plain-language description of what's going on and where.
- **Objects**: the things it spotted, each with a confidence bar.
- **Vehicles**: type, color, brand and model where it can tell (a Tesla Model 3, an F-150), and a plate if one is readable.
- **Text**: anything written in the image — a sign, a label, a document — with the language it's in.
- **Safety**: a flag for anything worth a second look, like fire, a weapon, or a hazard, marked from normal to critical.

You can pick which of these you care about before you run it, and every analysis is kept in a history gallery so you can go back to it later.

## In Chat

You don't have to open Recognition to use it. In a conversation with your companion, attach a photo and just ask about it — "what breed is this?", "what does this label say?", "is that a package on the porch or a person?" The companion looks at the image with the same local vision model and answers in the flow of the chat.

## For Peace of Mind

Recognition is genuinely useful for keeping an eye on things: glance at a camera snapshot and know whether that's a delivery or a stranger, read the fine print on a medication box, or identify an appliance you can't name. Because it runs at home, you can point it at family photos and doorstep snapshots without a single one being uploaded, profiled, or stored on someone else's server.

## A Note on the Internet

Recognition runs on a vision model installed on your own server. Once that model is in place it works completely offline, and no image you analyze ever leaves your network. A larger vision model sees more detail — worth choosing if you lean on the safety flags.
