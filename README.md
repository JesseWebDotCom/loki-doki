<div align="center">

<a name="readme-top"></a>

<img src="./assets/readme/readme-home-hero.svg" height="320" alt="LokiDoki home AI overview" />

# LokiDoki

**The private, personal AI platform for your home.**

LokiDoki brings AI into the home without sending your life to the cloud. It runs on your hardware, keeps household data local, and gives each person their own companion with their own character, voice, settings, and guardrails.

<img src="https://img.shields.io/badge/Status-Early%20Development-orange?style=for-the-badge" alt="Status" />
<img src="https://img.shields.io/badge/Stack-FastAPI%20%7C%20React%20%7C%20Ollama-blue?style=for-the-badge" alt="Stack" />
<img src="https://img.shields.io/badge/Hardware-Mac%20%7C%20Raspberry%20Pi%20%7C%20Hailo-purple?style=for-the-badge" alt="Hardware" />
<img src="https://img.shields.io/badge/License-FSL--1.1--MIT-green?style=for-the-badge" alt="License" />

<sub><i>LokiDoki is already usable, but not every feature is fully built or polished yet.</i></sub>

</div>

## 💡 What is LokiDoki?

Think of LokiDoki as a **local alternative** to cloud assistants — like ChatGPT and Claude for conversation, and like Alexa for voice-driven home control — but running on your own hardware, in your own house. It is built for the whole family, with a distinct personality and memory for every person, voice and visual companions, and parent-level controls over what each person can see and do.

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

## 🏡 Why LokiDoki?

- **Your data never leaves your house.** Conversations, memory, photos, and documents are all processed locally. No cloud account to breach, no vendor log to leak, no training set to be scraped into.
- **You don't rent your AI.** No monthly subscription. No per-seat pricing. No paid-for feature disappearing next quarter because pricing changed.
- **Works when the internet doesn't.** LokiDoki can run offline. Chat, voice, companions, and your own data work without a connection out of the box — and with optional cached content like Wikipedia, WebMD, and other references, you can keep looking things up during a blackout, on a plane, in a country that blocks cloud AI, or when a disaster knocks out the network. How much works offline depends on what you cache; local answers come back faster than any cloud round-trip either way.
- **Big AI is a single point of failure.** Today's cloud assistants could restrict access to government-only use, be shut down or acquired, get compromised, change their policies, or start selling your data. LokiDoki keeps working regardless — because it's yours.
- **You stay in control.** Set rules per person. Block swearing. Limit what kids can access. Turn off specific tools. The household decides what LokiDoki does — not a terms-of-service page written by someone else.
- **Built for everyone under your roof.** Each person gets their own companion with their own voice, face, personality, and memory — from a toddler learning letters to a grandparent who wants big text and patient explanations.

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

## ✨ Features

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-private.svg" alt="" width="42" align="absmiddle"> <strong>Private</strong><br><br>
      Runs on your hardware so conversations, settings, and memory stay at home.
    </td>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-no-subscriptions.svg" alt="" width="42" align="absmiddle"> <strong>No subscriptions</strong><br><br>
      No monthly AI bill and no cloud account required to make LokiDoki part of your home.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-smart-ai.svg" alt="" width="42" align="absmiddle"> <strong>Smart AI</strong><br><br>
      Natural chat, document and image understanding, live vision, wake word, push-to-talk, and voice interaction.
    </td>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-family.svg" alt="" width="42" align="absmiddle"> <strong>For the family</strong><br><br>
      Recognizes who is there and adapts companions, settings, and care profiles for different people in one home.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-personal.svg" alt="" width="42" align="absmiddle"> <strong>Personal</strong><br><br>
      Shape each experience with voices, behavior, companion style, and support for calmer or simpler replies.
    </td>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-control.svg" alt="" width="42" align="absmiddle"> <strong>Safe and in your control</strong><br><br>
      Set rules like no swearing, limit what each person can access, and manage household-wide and device-level permissions and guardrails.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-companions.svg" alt="" width="42" align="absmiddle"> <strong>Companions</strong><br><br>
      Give each person an animated AI character with its own face, voice, personality, and presence.
    </td>
    <td width="50%" valign="top">
      <img src="./assets/readme/readme-icon-powerful.svg" alt="" width="42" align="absmiddle"> <strong>Extensible</strong><br><br>
      Add skills that help control your home, answer questions, and do useful work — or write your own.
    </td>
  </tr>
</table>

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

## ⚡️ Quick start

### Hardware

Runs on M-series Macs and Raspberry Pi 5 (including Hailo-enabled Pis). Future placements include purpose-built devices — an Echo-style speaker and a kids' animatronic teddy bear.

### Software

```bash
git clone https://github.com/JesseWebDotCom/loki-doki.git
cd loki-doki
chmod +x run.sh
./run.sh
```

`run.sh` is the launcher. It handles setup and starts LokiDoki.

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

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

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

## 🛠️ Tech stack

| **Component**      | **Technology**                                                                                     | **Description**                                                                                  |
| :----------------- | :------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| **Frontend**       | <img src="https://skillicons.dev/icons?i=react,vite,ts,tailwind" valign="middle" />                | React + Vite + TypeScript + Tailwind + shadcn/ui, styled with the Onyx Material design system.  |
| **Backend**        | <img src="https://skillicons.dev/icons?i=python,fastapi" valign="middle" />                        | FastAPI control plane managed with `uv`. Serves the React bundle and the internal API.          |
| **LLM Runtime**    | <img src="https://skillicons.dev/icons?i=linux,bash" valign="middle" />                            | Qwen (chat) and a Gemma ~270M function-calling model, both via Ollama. Hailo-accelerated on Pi. |
| **Voice**          | <img src="https://skillicons.dev/icons?i=raspberrypi" valign="middle" />                           | `faster-whisper` or `whisper.cpp` for STT, Piper for TTS, openWakeWord for wake — all CPU only. |
| **Data**           | <img src="https://skillicons.dev/icons?i=sqlite" valign="middle" />                                | SQLite for users, memory, and settings. JWT auth, no external user system.                      |
| **Hardware**       | <img src="https://skillicons.dev/icons?i=apple,raspberrypi" valign="middle" />                     | M-series Mac for development; Raspberry Pi 5 (with optional Hailo) for home deployment.         |

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

## 🗺️ Roadmap

- [x] Core platform — FastAPI control plane, orchestrator, classifier
- [x] Skills-First pipeline — decomposition → skills → synthesis
- [x] Seven-tier memory, scoped per household member
- [x] Persona / companion system
- [x] Voice pipeline — wake word, push-to-talk, STT, TTS on CPU
- [x] Mac profile
- [ ] Pi CPU profile — first-class Raspberry Pi 5 deployment
- [ ] Pi Hailo profile — LLM and vision acceleration with CPU fallback
- [ ] Face and person recognition — know who is in the room and switch profiles automatically
- [ ] Document understanding — summarize, Q&A, and extract from PDFs and images
- [ ] Image and video understanding — describe, caption, and search your media library
- [ ] Live video — real-time scene understanding from a camera feed
- [ ] Home automation skills — lights, locks, climate, scenes
- [ ] Everyday skills — calendar, weather, notifications, web search
- [ ] Offline knowledge cache — bundled Wikipedia, WebMD, and other references for fully offline answers
- [ ] Browser bootstrap installer
- [ ] Plugin marketplace
- [ ] Device builds — Echo-style speaker and animatronic teddy bear
- [ ] Systemd / launchd auto-start

<div align="right"><a href="#readme-top">&nwarr; Back to top</a></div>

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
