---
title: Shopping / Price Tracker
description: Household-shared product tracking with per-retailer adapters, self-healing extraction, a background poller, coupons, deals, and per-user effective pricing.
sidebar:
  order: 23
---

## Overview

Products, listings, and price history are **household-wide** (one scrape serves everyone tracking the same item); watches and discounts are **per-user**, and every price-bearing response carries the caller's *effective* price (their own discounts applied) alongside the sticker price, so "best offer" means best for them specifically.

Engine lives in `backend/src/lib/shopping/`. Exposed at `/api/shopping` (`backend/src/routes/shopping.ts`, 700+ lines) and as the `shopping` chat tool (`backend/src/tools/shopping.ts`). Frontend is the Shopping app (`/shopping`).

## Retailer adapters (`lib/shopping/adapters/`)

Per-retailer parsers: `amazon.ts`, `walmart.ts`, `target.ts`, `bigbox.ts` (Home Depot/Lowe's family), and `generic.ts` (a best-effort extractor for arbitrary product URLs that don't match a known retailer). Each adapter implements search + detail extraction; `adapterFor()` and `searchableAdapters()` in `adapters/index.ts` dispatch by retailer id.

### Self-healing extraction (`selfHeal.ts`)

Per-retailer regex parsers are fast and cheap but brittle: a store HTML change silently returns nothing. Rather than run a maintained scraping engine (all of which want Docker), extraction heals in place: if the fast parser fails on a page that clearly loaded, it falls back to a local-LLM read of the page text (Ollama, no Docker) so tracking keeps working. Failures are counted, so a systematically broken parser notifies an admin to update the regex instead of failing silently forever.

## Background poller (`poller.ts`)

Wakes every 5 minutes and checks any listing whose jittered ~4h interval has elapsed. Two lanes: plain-fetch retailers run with small concurrency behind a shared per-host throttle; browser-lane retailers (Akamai-fronted, needing a rendered page) run strictly one at a time with an extra sleep between items to stay polite. Failures back off exponentially (up to 48h between checks) and, after `FAILS_BEFORE_ADMIN_NOTE` (5) consecutive failures, emit an admin notification. Per-listing jitter is deterministic (hashed from the listing id) so the whole fleet stays permanently staggered rather than thundering together after a restart.

## Coupons (`coupons.ts`)

Most coupon aggregators (RetailMeNot, etc.) are Cloudflare-gated; **CouponFollow** serves its per-store pages plainly. Offer descriptions ("40% Off Your Order") are surfaced next to each retailer in a product's offer table with a link to the coupon page; codes themselves sit behind a click-through redirect on CouponFollow's side, so they're intentionally not scraped, only linked to. Cached 6h.

## Deals feed (`deals.ts`)

Slickdeals publishes a keyless RSS feed of community-vetted deals (front page, plus per-search-term). Parsed with the shared feed parser; each item carries a title, a best-effort price and retailer guess parsed from the text, and a link. If the link resolves to a supported retailer, the UI offers a one-tap "track". Cached 30 minutes.

## Photo/barcode identify (`identify.ts`)

A phone photo of a barcode or the product itself is read by the vision model to suggest candidate listings to track, reusing the same VLM path as Home Inventory and Vision.

## Effective pricing (`discounts.ts`)

Per-user discount profiles (a store card, military/student rate, membership tier) are applied to the sticker price the same way a real checkout would compound them, so `effectiveFor(user, listing)` returns what that specific user would actually pay, not just the raw scraped price.

## Routes (`/api/shopping`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/search` | Cross-retailer search by product name |
| `GET` | `/market` | Bing Shopping cross-web offer check for an arbitrary title |
| `GET`/`POST` | `/saved` | Favorites + recently-viewed (per user) |
| `GET` | `/deals` | Slickdeals feed |
| `POST` | `/identify` | Photo/barcode → candidate listings |
| `POST` | `/resolve` | Resolve a pasted URL to a trackable listing |
| `GET`/`POST` | `/products` | List / start tracking a product |
| `GET` | `/products/:id`, `/market`, `/history` | Detail, cross-web offers, price history |
| `POST` | `/products/:id/find-offers`, `/refresh`, `/listings` | Re-scan, force refresh, add a retailer listing |
| `POST`/`DELETE` | `/products/:id/watches`, `/watches/:id` | Price-drop alerts |
| `GET`/`POST`/`DELETE` | `/discounts` | Per-user discount profile |

## Status

Amazon, Walmart, and Target support direct scraping; Home Depot and Lowe's are Akamai-blocked with no keyless API, so they're covered only via the generic extractor and the Bing Shopping cross-check, not a dedicated adapter.
