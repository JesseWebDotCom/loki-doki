# LokiDoki Character System Design Document

## 1. Goal
Create a modular system where users can choose from pre-configured "Characters" that define the bot's visual appearance (DiceBear), personality (LLM instructions), voice (Piper), and wake word (OpenWakeWord). Administrators can build and manage these characters through a modern, interactive playground.

## 2. Core Components

### 2.1. Visual Identity (DiceBear)
- **Styles**: Avataaars, Bottts, and Toon Head.
- **Renderer**: React-based DiceBear renderer using standard options.
- **Animation**: Basic viseme-based animation (mouth movement) synced with Piper TTS phoneme events.

### 2.2. Voice Identity (Piper TTS)
- **Selection**: Admin can choose from multiple Piper ONNX voices.
- **Phonetics**: Custom phonetic spelling for the character's name to ensure correct pronunciation during "I am [X]" introductions.
- **Permissions**: Voices can be marked as "Global" (available to all characters) or "Exclusive" (only for specific characters).

### 2.3. Personality (LLM Prompting)
- **Name**: The display name of the character.
- **Description**: A short (<10 word) tagline visible in the selection menu.
- **Behavior Prompt**: System instructions specific to the character (e.g., "Speak like a helpful robot with a slight glitch").

### 2.4. Wake Word (OpenWakeWord)
- **Assignment**: Each character can be tied to a specific wake word.
- **Management**: Admins can upload `.tflite` OWW models or select from defaults.

---

## 3. Data Model (Proposed)

### Character Schema
| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `UUID` | Primary identifier. |
| `name` | `String` | Display name. |
| `phonetic_name` | `String` | Phonetic spelling for TTS. |
| `description` | `String` | Short tagline (<10 words). |
| `behavior_prompt` | `String` | System instructions for LLM. |
| `avatar_style` | `Enum` | `avataaar`, `bottts`, `toon-head`. |
| `avatar_config` | `JSON` | Options for the DiceBear style (colors, eyes, etc). |
| `voice_id` | `String` | Link to Piper Voice ID. |
| `wakeword_id` | `String` | Link to OpenWakeWord model. |
| `is_preconfigured` | `Boolean` | True if created by Admin. |

### Voice Schema
| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `String` | Piper ID (e.g., `en_US-lessac-medium`). |
| `display_name` | `String` | Human-readable name. |
| `is_global` | `Boolean` | If true, user can see it in general settings. |
| `status` | `Enum` | `installed`, `missing`, `downloading`. |

---

## 4. Administrative Experience

### Character Playground
A modern, visual editor inspired by the DiceBear playground:
- **Style Selector**: Toggle between Avataaars, Bottts, and Toon Head.
- **Live Preview**: Real-time rendering of the avatar as options are changed.
- **Randomizer**: "Lucky" button to generate random looks.
- **Prompt Editor**: Text areas for name, phonetic name, description, and behavior.
- **Model Check**: Indicators for whether the assigned voice/wakeword is ready on disk.

---

## 5. User Experience

### Selection Flow
- Located in **Settings > Appearance**.
- **Character Cards**: Grid view showing the name, description, and a preview of the avatar.
- **Auto-Provisioning**: Selecting a character triggers a background task to ensure the required Voice and WakeWord are downloaded/installed.
- **Fallback**: If a voice is missing, the system defaults to the global system voice while downloading.

---

## 6. Phased Implementation Plan

### Phase 1: Data & API Foundation
- [ ] Implement SQLite tables for `characters`, `voices`, and `wakewords`.
- [ ] Create Python logic for managing Piper voice downloads and OpenWakeWord model storage.
- [ ] Build FastAPI routes for Character CRUD (Admin).
- [ ] Update `orchestrator.py` to inject character `behavior_prompt` into the system prompt.

### Phase 2: React Character Playground (Admin)
- [ ] Integrate `@dicebear/core` and collections in the frontend.
- [ ] Build the `CharacterEditor` component with live SVG preview.
- [ ] Add controls for voice/wakeword mapping.
- [ ] Implement the "Modernized Playground" aesthetic using Onyx Material.

### Phase 3: Voice & WakeWord Engine Enhancements
- [ ] Implement a `VoiceRegistry` to track installation status of Piper models.
- [ ] Add `OpenWakeWord` integration layer to backend.
- [ ] Create an "Admin > Audio Assets" tab for uploading `.tflite` files and installing Piper voices.

### Phase 4: User selection & Provisioning
- [ ] Build the user-facing "Character Picker" in Settings.
- [ ] Implement the "One-Click Install" logic (Backend handles parallel downloads of voice/wakeword).
- [ ] Add UI feedback (progress bars) for downloading assets.

### Phase 5: Animated Avatar Integration
- [ ] Replace static avatar with an `AnimatedAvatar` component.
- [ ] Use SSE events from `audio.py` (visemes/phonemes) to drive simple CSS/SVG animations.
- [ ] Final polish on transitions when switching characters.
