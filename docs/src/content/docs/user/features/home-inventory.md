---
title: Home Inventory
description: Tracking your home's appliances, devices, service history, and warranty alerts.
sidebar:
  order: 11
---

Your home's details (what you own, where it is, what it's worth) stay on your hardware. The AI identifies devices and keeps the records here, not in a vendor's cloud.

## Overview

Home Inventory is an AI-first tracker for your home's appliances, electronics, vehicles, tools, and furniture. Photograph any device and the AI reads its label, looks up the specs and manual, and builds a record for you. From then on you can search your stuff, keep a service log, and get warranty alerts.

Open it at `/home-inventory`.

## Adding a Device

1. Open Home Inventory and tap **Add**.
2. Take a photo of the device (its nameplate or model sticker works best) or upload one.
3. The AI runs two passes: it reads every word, number, and code on the label, and it describes what the object physically is. It then fills in the name, brand, model, serial number, and category.
4. Review the identified fields and save.

Once saved, a background web lookup kicks off. It finds the spec sheet, the official PDF manual, support contacts, product photos, and how-to videos, and folds them into the record. The card shows a small status icon while this runs and updates itself when it finishes. If the lookup can't find a manual or runs offline, the device is still saved with everything you and the photo provided.

You can also add a device by hand and fill in the brand and model yourself; the same web lookup runs from those.

## Manuals

When the lookup finds an official PDF manual, it caches it locally and pulls out the text. You can open the manual right in the app, and the AI can answer questions from it (see below). Manuals you upload yourself work the same way: drop in a PDF and the AI can read it.

## Service Log

Each device has a service log where you record:

- Repairs, maintenance, inspections, and upgrades
- Date, a description, who did the work, and the cost

This builds a running history so you always know when something was last serviced.

## Warranty Alerts

Add a purchase date and warranty expiry to a device and Home Inventory watches the clock. The page shows a banner for anything expired or expiring within 30 days, and each card flags warranties that lapse within 90 days. There's a built-in list of warranties expiring soon so nothing sneaks up on you.

## Asking the AI

You can ask your companion about your inventory in plain language:

- _"What appliances do I have in the garage?"_
- _"Is my fridge still under warranty?"_
- _"When was the HVAC last serviced?"_
- _"What's the error code E5 on my dishwasher?"_
- _"Find the support number for my printer."_
- _"How do I reset my router?"_

When you ask about a specific device, the AI reads that device's full record, including its service history, support links, and the relevant section of its cached manual, to answer.
