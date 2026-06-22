---
title: Offline Library (ZIM)
description: kiwix-serve integration, ZIM archive management, and the reader experience.
sidebar:
  order: 5
---

## Overview

The offline library serves ZIM archives (Wikipedia, medical references, etc.) via a **kiwix-serve subprocess** proxied through the backend. Archives appear as live cards on the Today page and open full-screen at `/read/:sourceId`.

---

## Architecture

```
kiwix-serve subprocess (port auto-assigned)
  ← proxied via backend /api/library/proxy/*
  ← ZIM files stored in data/zim/
```

The backend spawns kiwix-serve pointing at `data/zim/`. All browser requests go through the backend proxy, kiwix-serve is never exposed directly to the browser.

---

## Admin, AdminArchivesTab

- Add archives by ZIM file URL or local file path
- Download progress via SSE
- Enable/disable individual archives
- Archives stored in `zimArchives` DB table

---

## Today Page Integration

Enabled archives surface as **live cards** on the Today page, folded by category. Clicking a card opens the full-screen reader. The standalone Library page was removed, all library access is through Today.

---

## ReaderPage

Full-screen reader at `/read/:sourceId`. Renders the kiwix-serve proxy URL in an iframe. The back button returns to the calling context (Today or wherever the link was followed from).

---

## Adding New Archives

Archives can be sourced from:
- [library.kiwix.org](https://library.kiwix.org), official Kiwix library
- Any `.zim` file

After adding, the archive is immediately available in kiwix-serve without a restart.
