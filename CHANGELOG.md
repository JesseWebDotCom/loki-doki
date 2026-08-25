# Changelog

All notable changes to MaiPai Home. Format follows
[Keep a Changelog](https://keepachangelog.com); versions follow semver.

## [0.2.0] - 2026-08-25

### Added
- One-line installers for the server: `install.sh` (macOS/Linux) and
  `install.ps1` (Windows), served from the docs site. They install or update
  to the latest release, never `main`.
- MaiPai Desktop installers (macOS DMG, Windows setup) now build and attach
  to every release automatically.

### Changed
- Third-party UI assets (amCharts weather icons, Nerd Fonts symbols) are no
  longer tracked in the repository; they download at build time from their
  original sources, pinned and checksum-verified. The repository now contains
  only this project's own work, plus a NOTICE of what gets fetched.

## [0.1.0] - 2026-08-25

The first release under the MaiPai name. MaiPai Home is the continuation of
a project previously developed as "Loki Doki"; this release is a fresh
start under the getmaipai org with the full rebrand and a privacy scrub.

### Changed
- Product renamed: Loki Doki is now MaiPai Home; the desktop app (Doki
  Dock) is now MaiPai Desktop (`com.getmaipai.desktop`).
- Default companion is now MaiPai ("Hey MaiPai"); the in-development desk-robot
  starter companion is now Desktop Buddy (wakes to "Hey MaiPai" until a
  user picks another wake word). Existing installs migrate names automatically.
- Built-in TV channels and features renamed to MaiPai branding.
- Docs and repository moved to github.com/getmaipai/home; documentation now
  publishes to getmaipai.github.io/home.

### Removed
- Companion wakeword models no longer ship in the repo or the release. The
  repo carries only the MaiPai wake word; any other wake phrase is trained
  on your own hub, on demand, by the built-in trainer.
- Internal audit and design documents (archive-only now).

### Security
- Real LAN addresses replaced with documentation addresses in examples.
- Personal paths removed from comments and docs.
