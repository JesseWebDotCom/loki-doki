---
title: Update MaiPai Home
description: Get the newest release in one step.
sidebar:
  order: 3
---

**What you need:** about two minutes. Updates never touch your family's
data.

## The easy way

1. Open MaiPai Home as the admin.
2. Tap the settings icon, then **Server**.
3. Tap **Update**. The hub downloads the newest release, restarts itself,
   and comes back on its own.

You'll know it worked when the version shown on the Server page matches the
[latest release](https://github.com/getmaipai/home/releases/latest).

## The other way

Re-running the install command also updates you. It's safe to run again:

```sh
curl -fsSL https://getmaipai.github.io/home/install.sh | sh
```

On Windows (PowerShell):

```powershell
irm https://getmaipai.github.io/home/install.ps1 | iex
```

## Still need help?

Head to [Fix a problem](../fix-a-problem/) or
[tell us what happened](https://github.com/getmaipai/home/issues).
