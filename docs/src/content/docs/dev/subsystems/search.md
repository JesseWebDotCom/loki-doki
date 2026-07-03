---
title: Web Search Engine
description: Real keyless multi-engine web search backed by a managed SearXNG sidecar, with keyless scraper fallbacks. Internal to the companion and briefing pipeline, no end-user search UI.
sidebar:
  order: 21
---

## Overview

There is no search box anywhere in the app. This is the engine behind live-info answers ("who won last night's game"), the daily briefing sources, and image search for wallpapers/backdrops, exposed to the LLM as the `search` chat tool (`backend/src/tools/search.ts`) and used directly by `backend/src/lib/briefing/`.

Two layers:

- `backend/src/lib/searxng.ts`: a managed **SearXNG** metasearch sidecar.
- `backend/src/lib/webSearch.ts`: the caller-facing `webSearch()` function that queries SearXNG first, then falls back to keyless scrapers.

## Why a metasearch sidecar

From a residential/home server IP, bare server-side scraping of the big engines is largely dead: Google serves a JS-only shell to `fetch()` (zero parseable results) and CAPTCHAs headless Chromium; DuckDuckGo's HTML/`vqd` endpoints anomaly-block. SearXNG's per-engine adapters shape requests well enough to get through from the same IP that blocks a bare scraper, and because it aggregates roughly 20 engines, one blocked engine never sinks a query.

## SearXNG sidecar (`searxng.ts`)

Runtime: a Python ≥3.10 venv (`lib/python.ensurePython`) running SearXNG from a shallow git checkout via `python -m searx.webapp` (Flask dev server, fine for a single-user localhost bind, never exposed externally). Modeled on `lib/comfyui.ts`: idle → installing → starting → ready/failed state machine, a tail-based log ring, a PID file, and health polling on `/healthz`. Install/repair is wired through `lib/installRegistry`, so it installs and self-heals the same way ComfyUI or the voice sidecar do.

Binds to `SEARXNG_PORT` (8091) on localhost only. A generated secret and settings file persist under `data/searxng-settings.yml` / `data/searxng-secret`.

**AGPL-3.0 posture**: SearXNG is AGPL-licensed. It runs as a separate process, cloned unmodified from upstream, and attributed in the admin UI, not hidden or bundled into the app's own license.

## `webSearch()` (`webSearch.ts`)

Replaces the old DuckDuckGo Instant-Answer API, which is not a real web search endpoint (Wikipedia/Wikidata entity abstracts only, empty for general or current-events queries). Engines run **concurrently**, in priority order, each swallowing its own errors and returning `[]` on failure; results are merged by priority and deduped by URL, so one slow or blocked engine never sinks a query:

0. **SearXNG** (leads when installed and running)
1. **Google** (via `google-sr`, often empty from a server IP but kept since it works on some networks)
2. **DuckDuckGo** (via `duck-duck-scrape`)
3. **Mojeek** (independent crawler, scrape-friendly from any IP)
4. **Marginalia** (independent index, free keyless JSON API)

## User-visible surface

None directly. The only visible trace is an installed/running status badge for SearXNG in **Admin → Features**, alongside the AGPL attribution, and the periodic weekly `git pull` auto-updater that keeps the checkout current. Everything else is invisible plumbing behind the companion's `search` tool and the briefing pipeline.
