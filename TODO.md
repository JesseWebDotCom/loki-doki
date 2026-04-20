# LokiDoki TODO

## 1. Fix existing mac install issues
When setting up parent/child nodes, create/use a system like lmlink where the LLM procesing is happenign remotely over tailscale

## 3. Multi-user presence & cross-session interaction
Allow users to see other members' characters, whether they are active, and interact with them.

**Example:** You see Daisy's character is awake (she's using LokiDoki). You can either:
- Direct message her — your character appears on her screen, or
- Instruct her character to speak something without her prompting it.

**Privacy rules (required before build):**
- Per-user policy for inbound interactions:
  - *Open*: anyone approved can "hop in" without prompt (e.g., Daisy → open to close contacts).
  - *Approval required*: each inbound interaction prompts the recipient, similar to screen-control approval.
- Presence visibility is itself opt-in (awake/asleep/invisible).
- Audit log of who spoke through whose character and when.
- Scope decisions: does this live in core, a plugin, or a new shared-presence service? (TBD — likely plugin + core presence hooks.)
