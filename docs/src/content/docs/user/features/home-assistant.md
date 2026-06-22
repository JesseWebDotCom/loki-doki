---
title: Home Control
description: Control your smart home (lights, locks, thermostats, scenes) by talking, or tap devices on a dashboard. Powered by your own Home Assistant.
sidebar:
  order: 12
---

Tell your companion to turn off the lights, lock a door, or set a room's brightness, and it does it. Loki Doki connects to your own [Home Assistant](https://www.home-assistant.io/) on your network and controls your devices directly. Nothing about your home leaves your network.

## Overview

There are two ways to control your home:

- **Talk to your companion.** Say "turn off the office lights" and it happens. Loki Doki understands the command itself, so you can phrase things naturally instead of memorizing exact wording. It keeps a live, always-current picture of your devices and rooms, so commands resolve instantly.
- **Tap the dashboard.** Open Home Control (`/home-assistant`) for a room-by-room grid of your devices. Tap a light or switch to toggle it; the state updates as you go.

## Setup (admin)

1. In Home Assistant, create a token: **Profile → Security → Long-lived access tokens**.
2. In Loki Doki, go to **Admin → Features → Home Assistant → Config**.
3. Enter your **Home Assistant URL** (e.g. `http://homeassistant.local:8123`) and paste the **token**.
4. Click **Sync now**. You should see the connection status with the number of entities and rooms.

## What you can say

**Control:**

- _"Turn off the office lights"_
- _"Turn on the kitchen lights"_
- _"Set the bedroom lights to 30%"_
- _"Lock the front door"_
- _"Close the garage door"_
- _"Activate movie night scene"_
- _"Turn off all the lights"_

**Ask about state:**

- _"Are the office lights on?"_
- _"Is the front door locked?"_
- _"What's on in the living room?"_

## Follow-ups

You can correct or adjust the thing you just controlled without repeating yourself:

- _"Set the office lights to 50%"_ → _"oops, I meant 20"_
- _"Turn on the bedroom lights"_ → _"actually, turn those off"_

## Permissions

Control is permissioned **per user, per room, and per device type**. An admin can grant a user control of everything, only certain device types (e.g. just lights), only certain rooms (e.g. only their own bedroom), or any combination. Set this under **Admin → Features → Home Assistant → Control permissions**. Admins can control everything; a user with no grants can't control anything.

## Tips

- Commands like _"office lights"_ work best when your devices are assigned to **areas (rooms)** in Home Assistant. The more your entities are organized into rooms, the better natural commands resolve.
- Naming a specific device works too (e.g. _"the office ceiling light"_) when that device has a recognizable name in Home Assistant.
- If the connection drops, Loki Doki reconnects automatically; use **Sync now** to force an immediate refresh after changing devices or credentials.
