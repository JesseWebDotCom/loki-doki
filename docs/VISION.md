# LokiDoki — Product Vision

*The private, local AI platform for your home and family.*

---

## What LokiDoki Is

LokiDoki is a self-hosted AI platform that runs entirely on your own hardware — no cloud subscriptions, no data leaving your home. It gives every family member their own AI companion: a character with a chosen name, face, voice, and personality that knows them, remembers them, and grows with them over time.

It replaces the smart speaker on the kitchen counter, the echo show in the hallway, and the "hey Siri" habit — with something that actually knows your family, respects your privacy, and stays yours.

---

## Core Principles

- **Private by default** — all inference, memory, and data stays on your hardware
- **Family-aware** — the AI understands who it's talking to and the relationships between them
- **Per-person, not per-device** — your companion follows you across nodes; the device is just a window
- **Works offline** — every node holds a full local copy and runs standalone if the network is down
- **You are in control** — parents set permissions, administrators set guardrails, nothing happens without your rules

---

## Every Family Member Gets

### Their Own Identity
- Login with password or face recognition or voice recognition
- Personal profile: name, age, preferences, relationships to other members
- Their own AI companion: chosen name, appearance, voice, and personality

### Their Own Companion
- **Name** — call it whatever they want (Loki, Max, Aria, Buddy...)
- **Appearance** — animated character: face, body style, color scheme
- **Voice** — chosen from available Piper voices or downloaded
- **Personality** — shaped by their persona prompt and interaction history
- **Display modes** — overlay, docked, or fullscreen depending on the device

### Their Own Memory
- The companion remembers conversations, preferences, and facts across sessions
- "Remember I have a soccer game Friday" — it will
- Memories are scoped: some are personal, some are shared with the family

### Their Own Settings
- Site theme (colors, font size, layout)
- Preferred language and response style
- Notification preferences
- Connected services (their own Gmail, calendar, etc.)

### Their Own Permissions
Set by a parent or administrator — examples:
- ✅ Can ask about the weather
- ✅ Can control bedroom lights
- ❌ Cannot use image generation
- ❌ Cannot access the internet
- ❌ Cannot see other family members' memories

---

## Administrator Controls

### Prompt Injection
Parents can prepend rules to every prompt for a family member — invisibly, without the child seeing:
- *"Always respond simply. No swearing. No scary content. If asked about something inappropriate, redirect warmly."*
- *"This user is 7 years old. Keep answers short and encouraging."*
- *"Remind this user to be polite if they are rude."*

### Permission System
Granular per-user permissions:
- Which connectors they can use (lights, calendar, web search...)
- Which subsystems they can access (image gen, video, live camera...)
- Time-of-day restrictions ("no screen time after 9pm")
- Content filters by age group

### Family Oversight
- Administrators can review interaction summaries (not full transcripts unless configured)
- Health and activity panel: is grandma's node online? Did she interact today?
- Alert rules: "notify me if [user] hasn't spoken to their companion in 48 hours"

---

## Family Memory and Relationships

The master node understands the family as a whole:

- **Relationships** — the AI knows that Sarah is Jake's mom, that Tom is grandpa, that Lily and Ben are siblings
- **Family memory** — shared facts: upcoming trips, household rules, important dates, allergies
- **Relationship-aware responses** — "Who is mom?" returns the right answer for each user
- **Shared creations** — stories, drawings, and generated content can be shared with specific family members
- **Shared tasks** — shopping lists, reminders, chores — visible to whoever should see them
- **Family calendar** — aggregated view across connected calendars, surfaced per-user based on relevance

---

## Node Types and Deployment

LokiDoki runs on a network of nodes. Each node is a physical device running the same codebase — only the profile and config differ.

### Master Node (typically Mac Mini or similar)
- Runs all heavy inference locally: LLM, vision, memory
- Holds the authoritative family database
- Exposes internal API for client nodes to offload work
- Backs up all node data
- Always-on recommended; nodes fall back to standalone if it goes offline
- Connected to Home Assistant, external APIs, family calendars

### Client Nodes
Each client node is a lightweight presence point — it handles its own audio, wake word, camera, and persona animation, and delegates heavy work to the master.

#### Hallway / Kitchen Panel
*Raspberry Pi 5 + 5" touchscreen — replaces the Amazon Echo Show*
- Wall-mounted, always-on
- Touchscreen + voice interaction
- Shows family calendar, reminders, weather
- Controls lights, switches, scenes via Home Assistant
- Any family member can walk up and interact — presence detection switches to the right user

#### Kids' Companion
*Raspberry Pi 5 inside a soft toy or custom enclosure — battery powered*
- A physical friend with a name and face the child chose
- Tells stories, plays word games, helps with homework
- Reminds them to brush teeth, take medicine, get ready for school
- Parent-controlled guardrails and prompt injection
- Speaks in a voice the child picked
- Works offline — no internet required

#### Elderly Care Node
*Raspberry Pi 5 + screen, placed in living room or bedroom*
- Gentle reminders: medication, hydration, appointments
- Monitors presence passively — alerts family if no activity detected
- Simple, large-text UI — no tech literacy required
- Can make video calls to family members (future)
- Escalates alerts to family administrator if wellness thresholds not met

#### Portable / Wearable Node (future)
*Battery-powered Pi — backpack, bedroom, travel*
- Personal companion that travels with the user
- Syncs with master when back on network
- Queues memories and interactions while offline

---

## Connectivity

### Tailscale (Always Connected)
All nodes are joined to a Tailscale network. This means:
- Nodes reach the master node from anywhere — home, school, grandma's house
- No port forwarding, no dynamic DNS, no VPN setup
- Secure, encrypted, private mesh — traffic never touches a cloud server
- Node goes to grandma's house: it still syncs, still offloads, still works

### Offline Operation
Every node holds a full local copy of its user data and can run fully standalone:
- LLM runs locally on the node
- Memories are read from local SQLite
- Writes queue locally and sync to master on reconnect
- No dependency on the internet or the master node for core function

### Sync Model
- Writes go local first, replicate to master asynchronously
- Offline writes queue in a sync table, flush on reconnect
- Master holds the authoritative copy; nodes hold full working replicas
- Conflict resolution: last-writer-wins by timestamp for simple facts

---

## Connectors (Per-User, Permission-Gated)

Each family member can connect their own services, subject to their permissions:

| Connector | Examples |
|---|---|
| Calendar | Google Calendar, iCal |
| Email | Gmail (read summaries, draft replies) |
| Home Automation | Home Assistant — lights, switches, climate, scenes, sensors |
| Weather | Local weather, forecasts |
| Web Search | Filtered by age/permission |
| Shopping | Add to shared shopping list |
| Notifications | Push alerts to family members |
| Media | Play music, control playback |
| Health (future) | Step count, sleep, medication reminders |

---

## Privacy and Security

- **No cloud LLM** — all inference runs on your hardware
- **No subscriptions** — no ongoing cost after hardware
- **No data exfiltration** — nothing leaves your Tailscale network
- **Local auth** — JWT-based, works offline, no external identity provider
- **Per-user encryption** (future) — personal memories encrypted at rest
- **Audit log** (future) — administrators can see what connectors were used and when

---

## Why This vs. Alexa / Google Home / ChatGPT

| | LokiDoki | Alexa/Google | ChatGPT |
|---|---|---|---|
| Knows your family | ✅ deeply | ❌ profiles only | ❌ no memory |
| Remembers you | ✅ permanently, locally | ⚠️ cloud only | ⚠️ cloud, limited |
| Works offline | ✅ fully | ❌ | ❌ |
| Your data stays home | ✅ | ❌ | ❌ |
| Per-person companion | ✅ named, voiced, animated | ❌ | ❌ |
| Parental controls | ✅ granular | ⚠️ basic | ❌ |
| Home automation | ✅ via HA | ✅ | ❌ |
| Costs per month | $0 after hardware | $0–$10 | $20+ |
| Kids' companion | ✅ physical + voice | ⚠️ generic | ❌ |
| Elderly care | ✅ wellness monitoring | ❌ | ❌ |

---

## The Hardware Vision

```
[ Mac Mini — Master Node ]
        |
        | Tailscale mesh
        |
   ┌────┴──────────────────────────────────┐
   │                                       │
[ Pi 5 + 5" screen ]           [ Pi 5 + 5" screen ]
  Kitchen panel                  Hallway panel
  "Hey Loki, lights off"         Family calendar view

[ Pi 5 in teddy bear ]         [ Pi 5 + screen ]
  Kids' room                     Grandma's living room
  "Tell me a story"              "Time for your pills, Margaret"
  Battery powered                Wellness monitoring + family alerts
```

All nodes sync via Tailscale. Master handles heavy inference. Each node works standalone if master is offline.

---

## Proactive Companion Intelligence

LokiDoki doesn't just answer questions — it pays attention and speaks up when it matters. This is what separates a companion from a chatbot.

### Contextual Awareness
The companion notices things and acts on them naturally, without being asked:

**Calendar awareness**
- "Good luck at your softball game today, Sarah — hope the weather holds up"
- "Hey, you've got a dentist appointment in an hour"
- "Don't forget — it's dad's birthday tomorrow"

**Activity and sensor awareness**
- "Keep going, only 5 minutes left on your ride" *(monitoring under-desk pedal cadence via Bluetooth)*
- "You've been sitting for two hours — want to take a stretch break?"
- "You hit your step goal today — nice work"

**Time and routine awareness**
- "It's 8:30 — time to start getting ready for school"
- "You usually go to bed around now. Want me to set a morning alarm?"
- "You haven't eaten lunch yet — it's almost 2pm"

**Home awareness**
- "It's getting cold in the living room — want me to bump the heat up?"
- "Looks like rain tomorrow morning — you might want an umbrella for school"
- "The front door has been unlocked for a while — did you mean to leave it open?"

**Relationship awareness**
- "Grandma hasn't been active today — want me to have her node check in on her?"
- "It's been a while since you called your mom"
- "Jake mentioned he was nervous about his test today — might be worth checking in"

### Node Self-Awareness
The companion is honest about its own state in a natural, characterful way:

- "I'm getting a little sleepy — I'm down to 15% battery" *(battery-powered node)*
- "I'm feeling a bit slow today — the master node isn't reachable, so I'm working on my own"
- "I can't check your calendar right now — looks like I lost my connection"
- "I'm back! Sorry about that — I was updating myself"

### Proactive Without Being Annoying
Key design rules for proactive behavior:
- **Once per event** — never repeat the same nudge in the same session
- **Timed appropriately** — calendar reminders fire at sensible lead times, not constantly
- **Dismissable** — user can say "got it" or "stop reminding me about that" and it listens
- **Personality-consistent** — proactive messages match the companion's voice and the user's age/profile
- **Silent by default for minor things** — low battery shows on screen first, only speaks if it gets critical
- **Never interrupts** — proactive messages queue and deliver at a natural pause, not mid-conversation

### Bluetooth and Peripheral Integration
The companion can monitor Bluetooth devices and act on their data:
- Under-desk pedals / bike trainers — cadence, duration, encouragement
- Heart rate monitors — effort level awareness
- Smart scales (future) — wellness tracking with appropriate sensitivity
- Presence beacons — know when a family member arrives home

---

## Future Directions

- **Video calls** between family nodes (Pi to Pi, fully local)
- **Shared storybook** — AI-generated illustrated stories saved to family library
- **Health integration** — Apple Health, Fitbit, medication adherence tracking
- **Per-user encrypted memory** — personal memories locked to the user's key
- **Voice cloning** — custom TTS voice trained on a few minutes of audio
- **Multi-user presence** — two people at a panel, split-screen persona mode
- **Wearable node** — small Pi-based device that travels with a family member
- **Guest mode** — temporary access for visitors, no persistent memory
