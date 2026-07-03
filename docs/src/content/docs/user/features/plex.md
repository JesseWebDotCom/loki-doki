---
title: Plex
description: Connect your Plex server so Shows and Movies know what you already own, sync your watchlist and watched status, and play video right in the app.
sidebar:
  order: 19
---

If your household runs a [Plex](https://www.plex.tv) media server, Loki Doki connects to it so the **Shows** and **Movies** apps know what's already in your library. No more paying to stream something you already own.

## What it adds

- **Plex badge**: when you look up a show or movie, Loki Doki checks your Plex library and marks the titles you already have, so you can tell at a glance what's at home versus what needs streaming.
- **On Deck and Recently Added**: rails on the Shows home page pulled straight from your Plex server.
- **Two-way watchlist**: add a title in Loki Doki and it lands on your Plex watchlist too, and vice versa.
- **Watched status sync**: marking something watched in Loki Doki scrobbles it in Plex, so your progress stays the same everywhere.
- **Play here**: for movies, a "Play here" button streams straight from your Plex server inside Loki Doki, no separate app needed.

## Setting it up

An admin connects the shared Plex server once, in **Admin → Plex**: sign in with Plex (a one-time code you approve at plex.tv) or enter a server URL and token by hand.

After that, each household member links their **own** Plex account in **Settings → Plex**. This keeps watchlists and watched status personal to each person rather than shared across the household, the same way they work in Plex itself.

## Your privacy

Streaming and library lookups happen between your Loki Doki instance and your Plex server directly, over your own network if the server is local. Your Plex access token is never exposed to the browser. If Plex isn't configured, or you haven't linked your account, the badges and features simply don't appear.
