---
title: Privacy System
description: PIN-gated adult content, hidden → revealed → extended state machine, countdown pill, and keyboard shortcut.
sidebar:
  order: 9
---

## Overview

Adult content (LoRAs, generated images) is gated behind a PIN. The system uses a three-state machine that auto-hides content after a timeout.

---

## State Machine

```
hidden (default)
  → PIN correct → revealed (30-second countdown begins)
  → countdown reaches 0 → hidden

revealed
  → user interacts → countdown resets to 30s
  → user clicks "extend" → extended (no countdown)

extended
  → user closes or navigates → revealed (countdown resumes)
  → countdown reaches 0 → hidden
```

---

## Countdown Pill

During the `revealed` state, a pill UI shows the remaining seconds (30-second countdown). The pill is:
- Visible only when adult content is unlocked
- Positioned as a floating overlay (not in the main content flow)
- Dismissible, dismissing returns to `hidden`

---

## Keyboard Shortcut

**⌘⇧P**: toggles adult content unlock. Prompts for PIN if currently hidden; hides immediately if currently revealed/extended.

---

## `is_adult` Flag

The `is_adult` boolean is set on:
- `imageLoras`, LoRAs marked adult by the admin
- `generated_images`, images generated with adult LoRAs active

When content is in the `hidden` state:
- Adult LoRAs are not shown in the LoRA picker
- Adult generated images are blurred/hidden in the gallery
- Adult images are excluded from video generation previews

---

## Admin, Privacy Tab

Admin → Privacy manages:
- Set/change the adult content PIN
- Configure the countdown duration (default 30s)
- View which LoRAs and image categories are marked adult
