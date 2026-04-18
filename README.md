<div align="center">

<a name="readme-top"></a>

<img src="./assets/readme/readme-home-hero.svg" height="320" alt="LokiDoki home AI overview" />

# LokiDoki

**The private, personal AI platform for your home.**

LokiDoki brings AI into the home without sending your life to the cloud. It runs on your hardware, keeps household data local, and gives each person their own companion with their own character, voice, settings, and guardrails.

<img src="https://img.shields.io/badge/Status-Early%20Development-orange?style=for-the-badge" alt="Status" />
<img src="https://img.shields.io/badge/Stack-FastAPI%20%7C%20React%20%7C%20MLX%20%7C%20llama.cpp-blue?style=for-the-badge" alt="Stack" />
<img src="https://img.shields.io/badge/Hardware-Mac%20%7C%20Raspberry%20Pi%20%7C%20Hailo-purple?style=for-the-badge" alt="Hardware" />
<img src="https://img.shields.io/badge/License-FSL--1.1--MIT-green?style=for-the-badge" alt="License" />

<sub><i>LokiDoki is already usable, but not every feature is fully built or polished yet.</i></sub>

<p>
  <a href="#features"><b>Features</b></a> &nbsp;·&nbsp;
  <a href="#quick-start">Quick Start</a> &nbsp;·&nbsp;
  <a href="#how-it-works">How it works</a> &nbsp;·&nbsp;
  <a href="#tech-stack">Tech Stack</a> &nbsp;·&nbsp;
  <a href="#roadmap">Roadmap</a> &nbsp;·&nbsp;
  <a href="#license">License</a>
</p>

</div>

## 💡 What is LokiDoki?

Think of LokiDoki as a **local alternative** to cloud assistants — like ChatGPT and Claude for conversation, and like Alexa for voice-driven home control — but running on your own hardware, in your own house. It is built for the whole family, with a distinct personality and memory for every person, voice and visual companions, and parent-level controls over what each person can see and do.

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

<a id="features"></a>

## ✨ Features

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-private.svg" alt="" width="42" align="absmiddle"> <strong>Private</strong><br><br>
      Conversations, memory, photos, and documents are all processed locally. No cloud account to breach, no vendor log to leak, no training set to be scraped into.
    </td>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-no-subscriptions.svg" alt="" width="42" align="absmiddle"> <strong>No subscriptions</strong><br><br>
      Buy your hardware once and the household assistant is yours. No monthly AI bill, no per-seat pricing, no paid-for feature disappearing next quarter.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-powerful.svg" alt="" width="42" align="absmiddle"> <strong>Works offline</strong><br><br>
      Keep chatting, controlling your home, and looking things up on a plane, during a blackout, or in a country that blocks cloud AI. Downloadable Kiwix archives — Wikipedia, MDWiki, WikEM, iFixit, Khan Academy, Arch Linux Wiki, and more — plus an interactive map, all searchable offline.
    </td>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-personal.svg" alt="" width="42" align="absmiddle"> <strong>Always yours</strong><br><br>
      Cloud assistants can be shut down, acquired, compromised, or change their rules overnight. LokiDoki keeps working regardless, because it lives on your hardware.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-smart-ai.svg" alt="" width="42" align="absmiddle"> <strong>Smart</strong><br><br>
      Natural chat, document and image understanding, live vision, wake word, push-to-talk, and full voice interaction.
    </td>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-family.svg" alt="" width="42" align="absmiddle"> <strong>For the family</strong><br><br>
      Recognizes who is there and adapts memory, companions, and permissions per person — from a toddler learning letters to a grandparent who wants big text.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-control.svg" alt="" width="42" align="absmiddle"> <strong>In your control</strong><br><br>
      Rules per person, blocked words, age-appropriate limits, and per-tool on/off. The household decides what LokiDoki does — not a terms-of-service page.
    </td>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-companions.svg" alt="" width="42" align="absmiddle"> <strong>Companions</strong><br><br>
      Every person gets their own animated AI character with its own face, voice, personality, memory, and tunable behavior.
    </td>
  </tr>
</table>

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

<a id="quick-start"></a>

## ⚡️ Quick start

### Hardware

Runs on Apple Silicon Macs, x86_64 Windows/Linux desktops, and Raspberry Pi 5 (including Hailo-enabled Pis). Intel Macs are not supported.

> **Platform note:** Active development and testing happens on macOS (Apple Silicon). Windows, Linux, and Raspberry Pi profiles are implemented in the bootstrap and engine layers but **have not been tested on real hardware yet**. They should work based on the architecture, but expect rough edges until they get real-world validation.
### Install

The only prerequisite is a Python 3.8+ interpreter on the system. A browser opens to the install wizard, which downloads an embedded Python, Node, and the right LLM engine for your platform (MLX on mac, llama.cpp Vulkan on Windows/Linux, llama.cpp CPU on Pi, hailo-ollama on Pi + Hailo HAT), plus the Qwen LLMs and vision models sized for your hardware. First run takes 10–30 minutes depending on network; subsequent runs start in seconds.

#### macOS (Apple Silicon)

```bash
git clone https://github.com/JesseWebDotCom/loki-doki
cd loki-doki
./run.sh
```

#### Linux (x86_64 desktop) and Raspberry Pi 5

```bash
git clone https://github.com/JesseWebDotCom/loki-doki
cd loki-doki
./run.sh
```

#### Windows

```
git clone https://github.com/JesseWebDotCom/loki-doki
cd loki-doki
run.bat
```

#### Prerequisites

- **macOS** — Apple Silicon required. Intel Macs are not supported. If you don't have Python, run `xcode-select --install`.
- **Linux** — your distribution's `python3` (Raspberry Pi OS ships one).
- **Windows** — Python 3.11+ from https://python.org if not already installed. The launcher will prompt if it can't find one.

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

<a id="how-it-works"></a>

## 🧠 How it works

### Skills-First, LLM-Last

A small classifier decides intent, deterministic skills do the work, and the LLM only speaks when it actually needs to. This is faster, uses far less memory, and gives accurate answers for the many things that don't need a 9B model to hallucinate through.

```
input → classifier → route → skill / subsystem → response
```

### Memory

Seven-tier memory — from short-term working state all the way up to long-term identity — scoped per person in the household. LokiDoki remembers what matters to each user without mixing their context together.

### Characters & Personalization

Every user gets their own animated companion with its own face, voice, personality, and presence. Tone, verbosity, guardrails, and behavior are all tunable per person — so the AI a kid talks to is not the same AI a grandparent talks to.

### Households & People

LokiDoki is built around a household, not a single account. It recognizes who is there, adapts settings and care profiles per person, and applies household-wide and per-person permissions so parents stay in control of what their family can access.

### Offline Knowledge Archives

Pick from a curated catalog of [Kiwix](https://kiwix.org) ZIM archives — Wikipedia, Wiktionary, Wikiquote, Wikisource, iFixit, Stack Exchange, MDWiki, WikEM, Khan Academy, freeCodeCamp, Gutenberg, CIA World Factbook, Arch Linux Wiki, Appropedia, OpenStreetMap Wiki, TED Talks, and more. A single search bar queries everything at once; a per-archive landing page gives each source a Wikipedia-portal-style home with Random Article, scoped search, and recently viewed. The decomposer routes medical/how-to/country-facts questions to the right archive family automatically (MDWiki for symptoms, WikEM for first aid, Factbook for country stats), so the assistant answers from local disk first and only falls back to the web when a ZIM misses.

### Maps

An interactive [MapLibre GL JS](https://maplibre.org/) map with OpenStreetMap tiles, country-scoped address/city/ZIP search via [Nominatim](https://nominatim.org/), and a drop-pin-and-fly result flow. The map style is isolated so a Protomaps PMTiles swap takes it fully offline without touching the UI.

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

<a id="tech-stack"></a>

## 🛠️ Tech stack

| **Component**      | **Technology**                                                                                     | **Description**                                                                                  |
| :----------------- | :------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| **Frontend**       | <img src="https://skillicons.dev/icons?i=react,vite,ts,tailwind" valign="middle" />                | React + Vite + TypeScript + Tailwind + shadcn/ui, styled with the Onyx Material design system.  |
| **Backend**        | <img src="https://skillicons.dev/icons?i=python,fastapi" valign="middle" />                        | FastAPI control plane managed with `uv`. Serves the React bundle and the internal API.          |
| **LLM Runtime**    | <img src="https://skillicons.dev/icons?i=linux,bash" valign="middle" />                            | Qwen via best-of-breed engines per profile — MLX on mac, llama.cpp (Vulkan) on Windows/Linux, llama.cpp (CPU) on Pi, hailo-ollama on Pi + Hailo HAT. |
| **Voice**          | <img src="https://skillicons.dev/icons?i=raspberrypi" valign="middle" />                           | `faster-whisper` or `whisper.cpp` for STT, Piper for TTS, openWakeWord for wake — all CPU only. |
| **Data**           | <img src="https://skillicons.dev/icons?i=sqlite" valign="middle" />                                | SQLite for users, memory, and settings. JWT auth, no external user system.                      |
| **Hardware**       | <img src="https://skillicons.dev/icons?i=apple,raspberrypi" valign="middle" />                     | M-series Mac for development; Raspberry Pi 5 (with optional Hailo) for home deployment.         |

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

<a id="roadmap"></a>

## 🗺️ Roadmap

- [x] Core platform — FastAPI control plane, orchestrator, classifier
- [x] Skills-First pipeline — decomposition → routing → skills → synthesis
- [x] Pipeline v2 — LLM fallback, constraint extraction, slot scoring, response schemas, goal inference, entity canonicalization, hybrid memory retrieval
- [x] Seven-tier memory, scoped per household member
- [x] Memory unification — single SQLite DB, unified gate-chain writer and reader
- [x] Hybrid memory retrieval — FTS5 + embedding search with RRF merge
- [x] Persona / companion system
- [x] Offline knowledge archives — 21+ curated Kiwix ZIM sources (Wikipedia, MDWiki, WikEM, iFixit, Khan Academy, freeCodeCamp, Gutenberg, Appropedia, Arch Linux Wiki, CIA Factbook, OpenStreetMap Wiki, TED, and more), unified search, per-archive branded landing page, decomposer-driven routing to the right medical / how-to / country-facts family
- [x] Interactive maps — MapLibre GL JS + OpenStreetMap tiles, country-scoped Nominatim address search, fly-to-pin UX
- [x] LLM-driven routing prior — fast Qwen decomposer runs in parallel with MiniLM cosine match to tip borderline cases (~90% → 97% held-out corpus accuracy)
- [ ] Voice pipeline — wake word, STT, TTS on CPU
- [x] Mac profile (actively tested)
- [x] Browser bootstrap installer
- [x] Multi-turn conversation test suite — 55 persona-based scripts, 181 turns
- [ ] Pi CPU profile — implemented, not yet tested on real hardware
- [ ] Pi Hailo profile — implemented, not yet tested on real hardware
- [ ] Windows profile — implemented, not yet tested on real hardware
- [ ] Face and person recognition — know who is in the room and switch profiles automatically
- [ ] Document understanding — summarize, Q&A, and extract from PDFs and images
- [ ] Image and video understanding — describe, caption, and search your media library
- [ ] Live video — real-time scene understanding from a camera feed
- [ ] Home automation skills — lights, locks, climate, scenes
- [ ] Offline map tiles — Protomaps PMTiles swap so the Maps page works without any network
- [ ] Plugin marketplace
- [ ] Device builds — Echo-style speaker and animatronic teddy bear
- [ ] Systemd / launchd auto-start

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

<a id="license"></a>

## ⚠️ License

LokiDoki is licensed under the **[Functional Source License 1.1 (MIT Future License)](LICENSE)**. In short:

- **Free** for personal, educational, research, and internal business use.
- **Competing commercial use is restricted** for two years after each release.
- **Every release automatically converts to the MIT license** on the second anniversary of its publication.

If you want to use LokiDoki inside a commercial product that would otherwise be a Competing Use, [open an issue](https://github.com/JesseWebDotCom/loki-doki/issues) to discuss a commercial license.

Third-party attributions and upstream licenses are listed in [NOTICES.md](NOTICES.md).

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

## 🙏 Acknowledgements

- The Ollama, llama.cpp, and GGUF communities for making local LLMs genuinely usable on modest hardware
- Qwen and Google Gemma teams for open-weight models small enough to run at home
- Rhasspy / Piper, faster-whisper, and openWakeWord for high-quality CPU-only voice
- Hailo for a consumer-grade accelerator that makes Pi vision and inference practical
- Families who want an AI assistant that stays under their roof — this is for you

<br>

<p align="center">
  <sub>Built for a more private, more personal home.</sub>
</p>

<br>

---

<sub>ChatGPT is a trademark of OpenAI, OpenCo. Claude is a trademark of Anthropic, PBC. Alexa is a registered trademark of Amazon.com, Inc. Ollama, Qwen, Gemma, Raspberry Pi, Hailo, and all other names referenced herein are the trademarks of their respective owners. LokiDoki is not affiliated with, endorsed by, sponsored by, or otherwise connected to any of these companies. References are made solely for descriptive comparison under the doctrine of nominative fair use.</sub>
