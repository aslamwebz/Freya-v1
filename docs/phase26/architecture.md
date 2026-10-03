# Phase 26 — Architecture Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Natural Presence expands the richness and naturalness of Freya's presence —
her voice, her embodiment, her transitions — without inventing internal state.
Every presence state, animation, cue and transition is derived from real Core
state. No mood, no emotion, no mental state is claimed.

The core invariant:

> **Presence is a projection of real Core state, not an invention of internal
> state. Richer presence does not mean richer claims about what Freya is.**

---

## 2. Design principles

### 2.1 Derived, never invented

Every presence state, animation, cue and transition is derived from real Core
state. No presence state is invented, no animation is chosen by a renderer,
and no cue is fabricated.

### 2.2 Bounded everywhere

Every presence frame has:
- A maximum number of transition history entries
- A maximum number of embodiment cues
- A maximum number of voice session history entries
- A maximum length for each string

### 2.3 Authority-preserving

Before any presence change is rendered:
1. Guard capability check passes
2. Governor cognition authorization is available (if cognition is needed)
3. STOP ALL is not active
4. Budget remaining is sufficient
5. Approval requirements are met (or the change is pre-approved)

No component can bypass any of these.

### 2.4 Deterministic

The presence state machine is deterministic: same inputs + same clock = same
state. This is testable and auditable.

### 2.5 Explainable

Every presence change carries:
- What changed
- Why it changed
- What Core state caused the change
- What is uncertain

### 2.6 Event-sourced

All presence state is derived from the event journal. On restart:
1. Replay the journal
2. Rebuild presence state
3. Reconcile interrupted transitions
4. Resume or terminate explicitly

---

## 3. Components

### 3.1 PresenceStateMachine (expanded, Phase 26)

The existing 8 presence states are preserved. Phase 26 adds:
- Smoother transitions between states
- Bounded transition durations
- Transition history (bounded)

**New transitions:**
- `idle → listening` (voice capture started)
- `listening → thinking` (capture ended, cognition requested)
- `thinking → speaking` (synthesis started)
- `speaking → idle` (synthesis ended)
- `working → attention` (attention directive received)
- `attention → idle` (attention directive cleared)
- `error → idle` (STOP ALL deactivated)
- `degraded → idle` (fault cleared)

**No new states are added.** The 8 states are canonical.

### 3.2 VoiceInteraction (expanded, Phase 26)

The existing local-only voice service is preserved. Phase 26 adds:
- Multi-turn voice capture (bounded)
- Voice session history (bounded)
- Voice interaction patterns (bounded)

**New patterns:**
- `push-to-talk` — explicit press-and-release capture (existing)
- `multi-turn` — multiple captures in sequence (bounded)
- `voice-session` — a bounded sequence of captures and syntheses

**All voice remains local-only.** No cloud services.

### 3.3 EmbodimentCues (new, Phase 26)

Bounded, code-owned cues derived from real Core state:
- Attention-derived cues (from attention directives)
- Work-derived cues (from work projection)
- Voice-derived cues (from voice capture/synthesis status)
- Personality-derived cues (from personality projection)

**Cue types:**
- `attention-urgent` — an attention directive with urgent importance
- `attention-normal` — an attention directive with normal importance
- `work-running` — a run is executing
- `work-waiting` — a run is waiting
- `work-approval` — a run is awaiting approval
- `voice-listening` — voice capture is active
- `voice-speaking` — voice synthesis is active
- `personality-cue` — a personality cue is active

**No cues are invented.** Every cue is derived from real Core state.

### 3.4 PresenceFrame (expanded, Phase 26)

The existing presence frame is preserved. Phase 26 adds:
- Transition history (bounded)
- Embodiment cues (bounded)
- Voice session history (bounded)

**New fields:**
- `transitionHistory` — bounded list of recent transitions
- `embodimentCues` — bounded list of active embodiment cues
- `voiceSessionHistory` — bounded list of recent voice sessions

**All new fields are derived from real Core state.**

---

## 4. Data flow

```
Core State Change
    │
    ▼
PresenceStateMachine.deriveState(core, attention, work, personality, voice)
    │
    ├─ STOP ALL → error
    ├─ Integrity corrupt → error
    ├─ Degraded → degraded
    ├─ Synthesis active → speaking
    ├─ Capture active → listening
    ├─ Provider call in flight → working
    ├─ Run executing → working
    ├─ Attention directive → attention
    ├─ Personality cue → attention
    └─ Nothing → idle
    │
    ▼
PresenceFrame.build(state, transitionHistory, embodimentCue, voiceSessionHistory)
    │
    ▼
Renderer.draw(frame)
```

---

## 5. Integration with existing subsystems

### 5.1 Guard

The presence state machine checks capabilities through Guard. It does not
bypass Guard. A presence change cannot be rendered without Guard approval.

### 5.2 Governor

The presence state machine requests cognition through Governor. It does not
bypass Governor. A presence change cannot request cognition without a grant.

### 5.3 STOP ALL

The presence state machine checks STOP ALL before every state derivation. If
STOP ALL is active, the presence state is `error`.

### 5.4 Budgets

The presence state machine checks budgets before every state derivation. A
presence change cannot exceed the remaining budget.

### 5.5 Approvals

The presence state machine checks approval requirements before every state
derivation. A presence change that requires approval cannot proceed until the
approval is granted.

### 5.6 EventFabric

The presence state machine appends events through EventFabric.append(). It
does not create a parallel store.

---

## 6. Boundaries

### 6.1 What Phase 26 owns

- Presence state machine expansion
- Voice interaction expansion
- Embodiment cues
- Presence frame expansion

### 6.2 What Phase 26 does NOT own

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)

### 6.3 What Phase 26 does NOT invent

- Mood
- Emotion
- Mental state
- Personality traits not derived from real Core state
- Presence states not derived from real Core state
- Animations not derived from real Core state
- Cues not derived from real Core state

---

## 7. Failure modes

| Failure | Handling |
|---|---|
| Presence state derivation fails | Default to `idle` |
| Voice capture fails | Refused, journaled |
| Voice transcription fails | Refused, journaled |
| Voice synthesis fails | Refused, journaled |
| Embodiment cue derivation fails | Default to no cue |
| Presence frame build fails | Default to minimal frame |
| STOP ALL activated | `error` state |
| Restart during transition | Reconciled, journaled |
