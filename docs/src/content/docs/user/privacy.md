---
title: Privacy & Content Controls
description: How content levels, the adult-content PIN gate, and "your data stays home" work day to day.
sidebar:
  order: 10
---

Loki Doki is built so a whole family can share one server safely. The owner decides how mature the AI is allowed to get, each person can dial it down further for themselves, and the most sensitive material sits behind a PIN. And because the server is yours, none of it leaves your home.

## Your Data Stays Home

Everything here runs on your own server. Your chats, the content levels you pick, the images you make, and the links you keep all live on hardware you control. Nothing is sent to a cloud service to be logged, profiled, or sold. The privacy controls below are about who in your home sees what, not about what some outside company is allowed to collect, because the answer to that is always "nothing."

## Content Levels

What the AI is willing to say is set by four independent levels:

- **Profanity**
- **Sexual content**
- **Violence**
- **Substances** (drugs and crime)

Each level has three settings, from off (clean and family-friendly) up to fully open. You can set these yourself in **Settings → Privacy**, using the **Safe**, **Open**, or **Custom** presets or by tuning each level by hand.

Two limits sit above your choices:

- **A safety floor that never turns off.** No matter how you set your levels, the AI always refuses genuinely harmful or illegal requests (weapons, drug synthesis, content involving minors, and so on). This can't be disabled by anyone.
- **A ceiling set by your admin.** The owner of the server can cap how high any one person's levels can go. If you see "Some levels are limited by your administrator," that's your cap. It's how a parent keeps a child's account family-friendly while leaving their own unrestricted.

Your effective level is always the stricter of what you pick and what your admin allows.

### Companions

Each AI companion can have its own content style. A companion only shows up as usable if its style fits within your effective levels. If a companion is too mature for your account, it stays locked, so you can't accidentally step around your own limits by switching characters.

## Adult Content (the PIN Gate)

Some image styles (LoRAs), generated images, and music tracks can be marked as **adult**. These are hidden by default and require a PIN to reveal. This is separate from the content levels above: it controls visible media, not what the AI says.

### Unlocking

1. Trigger the unlock (your build may offer a lock button, or press **⌘⇧P** on Mac / **Ctrl+Shift+P** elsewhere)
2. Enter the PIN
3. Adult content becomes visible

### The Countdown

After you unlock, a pill shows the seconds remaining (30 by default, set by your admin). When it reaches zero, adult content hides itself again automatically.

If you want it to stay visible while you work, choose **keep open**: the countdown stops and content stays revealed until you hide it. To hide immediately at any time, press **⌘⇧P** again.

### Too Many Wrong Tries

The PIN is rate-limited. After several wrong attempts the gate locks for a while and tells you how long to wait. This protects against someone guessing the PIN.

### Your PIN

The adult-content PIN is set by your admin in the admin panel. If you need it changed, ask your admin.

## What's Not Logged

Adult-content decisions are a viewing preference held in your session, not an event written to any history or activity feed. Adult images and styles simply don't appear in the gallery or pickers until you unlock them.
