---
title: Links
description: Organizr-style bookmarks page with global and personal bookmarks, iframe viewer.
sidebar:
  order: 8
---

## Overview

The Links page is an Organizr-style bookmark launcher. It supports both **global bookmarks** (admin-managed, visible to all users) and **personal bookmarks** (per-user).

---

## Data Model

```
bookmarks table
  - id
  - user_id (null = global)
  - title
  - url
  - icon_url
  - category
  - sort_order
  - created_at
```

Global bookmarks have `user_id = null`. Personal bookmarks are scoped to the user.

---

## LinksPage

`/links`, renders bookmarks in a responsive grid, grouped by category. Each card shows the icon, title, and optionally a description.

Clicking a bookmark opens it in the **iframe viewer**: a full-screen overlay that keeps the user inside the app. The viewer has a toolbar with:
- Back/forward navigation
- Reload
- Open in new tab (escape hatch)
- Close

---

## Admin, AdminLinksTab

- Add / edit / delete global bookmarks
- Set icon (URL or uploaded)
- Assign category
- Reorder within category (drag-and-drop)

---

## Personal Bookmarks

Users can add their own bookmarks from the Links page. Personal bookmarks appear in a "My Links" section below the global ones. They are not visible to other users or admins.
