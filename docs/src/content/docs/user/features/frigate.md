---
title: Frigate Cameras
description: Connect your Frigate NVR so your companion describes and announces camera events — on your own network, with your own AI.
sidebar:
  order: 18
---

If you run [Frigate](https://frigate.video) for your security cameras, Loki Doki connects to it so your companion can describe what the cameras see and announce events out loud — a person at the front door, a car in the driveway — without anything leaving your network or relying on a cloud service.

## How it works

Frigate has a built-in "generative AI" feature that asks an outside service to describe snapshots of detected objects. Loki Doki acts as that service, but locally: it answers Frigate's requests using your **own vision model**, so the descriptions are generated on your hardware, not sent to OpenAI or anyone else.

When Frigate detects something, two things happen:

- Loki Doki **describes the snapshot** with its local vision model (what's in frame, what's happening).
- Your **companion announces it** out loud on whatever device you're using, using the camera, label, and severity from Frigate.

## Setting it up

An admin connects Frigate in **Admin → Frigate**: point Frigate's MQTT/base URL at your Loki Doki instance and set Frigate's generative-AI provider to the OpenAI-compatible endpoint Loki Doki exposes (authenticated with a token, since Frigate is a separate device on your LAN). Once configured, announcements start flowing automatically.

## Event history

A recent **events** list shows what the cameras have picked up, so you can glance back at what happened even if you missed the spoken announcement.

## Your privacy

Everything runs on your network. Snapshots are described by your local model, announcements play only on your devices, and nothing about your cameras is sent to any cloud service.
