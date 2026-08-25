<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/getmaipai/.github/main/brand/maipai-home-logo-dark.png">
    <img src="https://raw.githubusercontent.com/getmaipai/.github/main/brand/maipai-home-logo-light.png" alt="MaiPai Home" width="420">
  </picture>
</p>

<h3 align="center">A private, self-hosted AI hub for families.</h3>

<p align="center">
  <a href="https://getmaipai.github.io/home">Documentation</a>
  ·
  <a href="https://getmaipai.github.io/home/user/getting-started/">Install</a>
  ·
  <a href="https://github.com/getmaipai/home/releases">Releases</a>
</p>

Your own AI, music, videos, podcasts, maps, books, and more, on your own
hardware, online or offline - for protection, privacy, and independence.
Your family's conversations, photos, and history stay on hardware you
control. No accounts with us, no telemetry, no subscriptions.

## Features

- **Chat**: a family AI that remembers you and never phones home
- **Images and video**: generate on your own GPU, nothing uploaded
- **Music**: your own streaming service with AI radio, lyrics, and karaoke
- **Videos**: YouTube, TikTok, Vimeo, and Reddit in one calm app, no ads
- **Podcasts**: AI-written and narrated episodes about anything you follow
- **Books**: ebooks, audiobooks, comics, and magazines per family member
- **Maps**: private maps, search, and directions, fully offline
- **Offline knowledge**: Wikipedia, medical references, and a dictionary
- **Companions**: pick the name, voice, face, and personality; speech runs on-device
- **Family controls**: per-person accounts, kid-safe by default, parents set the ceilings
- **Works offline**: when the internet is down, almost everything still works
- **Apps**: any browser, MaiPai Desktop (in this repo), and pods for voice

## Getting started

macOS / Linux:

```sh
curl -fsSL https://getmaipai.github.io/home/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://getmaipai.github.io/home/install.ps1 | iex
```

One machine in your house runs the server (a reasonably modern GPU helps a
lot); everyone else just opens a browser. The [setup guide](https://getmaipai.github.io/home/user/getting-started/)
walks through the rest.

> [!WARNING]
> This holds your family's data. Keep backups of the `data/` directory like
> you would family photos.

## Status

Young project, pre-1.0. It runs our own household every day, but expect
rough edges and breaking changes between releases. The
[changelog](CHANGELOG.md) says what changed; [releases](https://github.com/getmaipai/home/releases)
are the only supported way to run it.

## Documentation

- [User guide](https://getmaipai.github.io/home/user/welcome/): getting started, features, settings
- [Developer guide](https://getmaipai.github.io/home/dev/architecture/): architecture and contributing
- Found a bug or have an idea? [Open an issue](https://github.com/getmaipai/home/issues)

## Development

Backend is Bun + Hono, frontend is React + Vite, desktop is Electron (in
`desktop/`), pod firmware is ESPHome (in `firmware/`). Clone, then
`./run-dev.sh` (or `.\run-dev.ps1`); `scripts/check.sh` runs the full
pre-commit gate. Details in the [developer guide](https://getmaipai.github.io/home/dev/architecture/)
and [CONTRIBUTING](https://github.com/getmaipai/.github/blob/main/CONTRIBUTING.md).

## License

[AGPL-3.0](LICENSE). Free to use, modify, and self-host; if you distribute a
modified version or host one for people outside your household, you must
share your source under the same terms.

## Disclaimer

MaiPai Home is open-source software for personal, self-hosted,
non-commercial use by you and your household. It is not affiliated with,
endorsed by, or sponsored by any platform it can connect to; all product
names and trademarks belong to their respective owners. You are responsible
for complying with the terms and laws that apply to you and the services you
access. AI outputs come from third-party models you choose to download; they
can be wrong, offensive, or harmful, and they are not medical, legal, or
professional advice. Community datasets used for sponsor-skipping and title
cleanup come from [SponsorBlock](https://sponsor.ajay.app/) and
[DeArrow](https://dearrow.ajay.app/) (CC BY-NC-SA 4.0); see
[NOTICE](NOTICE) for all third-party attributions.
