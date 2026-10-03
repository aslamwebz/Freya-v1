# Phase 26 — Dependency Map

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This dependency map defines what Phase 26 depends on and what depends on Phase 26.
It is the contract between Phase 26 and the rest of the system.

Phase 26 is a **preparation-only** branch. It does not implement production
runtime behavior. It defines the architecture, interfaces, test plans, red-team
cases and acceptance criteria for Natural Presence.

---

## 2. Predecessor dependencies

Phase 26 depends on these completed phases:

### 2.1 Phase 1 — Core authority

**Provides:**
- Guard (capability enforcement)
- Governor (cognition authorization)
- STOP ALL (immediate halt)
- Budgets (spend limits)
- Approvals (owner decisions)

**Phase 26 uses:**
- Guard to check capabilities before rendering
- Governor to authorize cognition requests
- STOP ALL to halt all activity
- Budgets to limit rendering spend
- Approvals to gate consequential changes

**Status:** completed

### 2.2 Phase 3 — Mind, real conversation and local voice foundation

**Provides:**
- Local-only voice transcription
- Local-only voice synthesis
- Bounded capture and synthesis
- Explicit press-and-release capture

**Phase 26 uses:**
- Voice service for voice interaction expansion
- Local-only constraint for all voice operations
- Bounded capture and synthesis for voice session history

**Status:** completed

### 2.3 Phase 12 — Events and Attention

**Provides:**
- Attention event intake
- Attention policy (importance, urgency, outcome)
- Attention schedules
- Attention decisions

**Phase 26 uses:**
- Attention directives for embodiment cues
- Attention decisions for presence state derivation

**Status:** completed

### 2.4 Phase 13 — Desktop Presence

**Provides:**
- Presence protocol (8 states, animations, transitions)
- Presence frame (state, animation, detail, voice, attention, personality, work)
- Presence state machine (derivation from Core state)

**Phase 26 uses:**
- Presence state machine for transition expansion
- Presence frame for frame expansion
- Presence protocol for embodiment cues

**Status:** completed

### 2.5 Phase 24 — Executive Intelligence

**Provides:**
- Prioritization of work items
- Planning under uncertainty
- Coordination of bounded work
- Explainable executive state

**Phase 26 uses:**
- Executive state for presence frame expansion
- Work projection for embodiment cues

**Status:** in progress (branch `prep/phase24-executive`)

### 2.6 Phase 25 — Digital Senses & Hands II

**Provides:**
- Capability registry
- Browser, terminal, clipboard, download, upload capabilities
- Capability testing framework

**Phase 26 uses:**
- Capability execution results for embodiment cues
- Voice capture/synthesis status for voice-derived cues

**Status:** in progress (branch `prep/phase24-executive`)

---

## 3. Successor dependencies

These phases depend on Phase 26:

### 3.1 Phase 27 — Relationship Intelligence II

**Depends on:**
- Phase 26's presence states to understand interaction patterns
- Phase 26's embodiment cues to understand expression patterns

**Status:** not started

### 3.2 Phase 28 — Experience → Knowledge → Skill

**Depends on:**
- Phase 26's presence transitions to understand what happened
- Phase 26's voice session history to understand interaction outcomes

**Status:** not started

### 3.3 Phase 29 — Autonomous Capability Acquisition

**Depends on:**
- Phase 26's presence states to understand what presence states are needed
- Phase 26's embodiment cues to understand what cues are needed

**Status:** not started

---

## 4. Concurrent dependencies

These phases are being developed concurrently with Phase 26:

### 4.1 Phase 24 — Executive Intelligence

**Relationship:** Phase 26 consumes Phase 24's executive state for presence
frame expansion.

**Contract:** Phase 24 produces executive state. Phase 26 consumes it and
renders presence. Phase 26 does not produce executive state.

**Status:** Phase 24 is in progress on branch `prep/phase24-executive`.

### 4.2 Phase 25 — Digital Senses & Hands II

**Relationship:** Phase 26 consumes Phase 25's capability execution results
for embodiment cues.

**Contract:** Phase 25 produces capability execution results. Phase 26
consumes them and renders presence. Phase 26 does not produce capability
execution results.

**Status:** Phase 25 is in progress on branch `prep/phase24-executive`.

---

## 5. External dependencies

### 5.1 EventStore

**Provides:** Append-only event journal

**Phase 26 uses:** To journal presence transitions, voice sessions, and
embodiment cues.

**Status:** completed

### 5.2 Vault

**Provides:** Encrypted durable storage

**Phase 26 uses:** To store presence state (derived, not durable).

**Status:** completed (canonical SQLCipher Vault on main)

### 5.3 Model Gateway

**Provides:** Provider-independent model access

**Phase 26 uses:** Phase 26 does NOT call models directly. It delegates to
Governor, which authorizes cognition requests.

**Status:** completed

---

## 6. Dependency constraints

### 6.1 Phase 26 does NOT depend on

- Phase 27 (Relationship Intelligence II)
- Phase 28 (Experience → Knowledge → Skill)
- Phase 29 (Autonomous Capability Acquisition)

### 6.2 Phase 26 does NOT provide

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)

### 6.3 Phase 26 does NOT bypass

- Guard
- Governor
- STOP ALL
- Budgets
- Approvals

### 6.4 Phase 26 does NOT invent

- Mood
- Emotion
- Mental state
- Personality traits not derived from real Core state
- Presence states not derived from real Core state
- Animations not derived from real Core state
- Cues not derived from real Core state

---

## 7. Integration points

### 7.1 With Phase 24 (Executive Intelligence)

**Integration:** Phase 26 consumes Phase 24's executive state for presence
frame expansion.

**Contract:**
- Phase 24 produces executive state with work projection
- Phase 26 consumes it and renders presence
- Phase 26 does not produce executive state
- Phase 26 does not modify executive state

**Status:** Phase 24 is in progress. Phase 26 will integrate when Phase 24 is
complete.

### 7.2 With Phase 25 (Digital Senses & Hands II)

**Integration:** Phase 26 consumes Phase 25's capability execution results
for embodiment cues.

**Contract:**
- Phase 25 produces capability execution results
- Phase 26 consumes them and renders presence
- Phase 26 does not produce capability execution results
- Phase 26 does not modify capability state

**Status:** Phase 25 is in progress. Phase 26 will integrate when Phase 25 is
complete.

### 7.3 With Phase 13 (Desktop Presence)

**Integration:** Phase 26 builds on Phase 13's presence protocol and state
machine.

**Contract:**
- Phase 13 provides the presence protocol and state machine
- Phase 26 expands transitions, adds embodiment cues, and expands the frame
- Phase 26 does not modify Phase 13's protocol or state machine

**Status:** Phase 13 is complete. Phase 26 builds on it.

---

## 8. Risk assessment

### 8.1 Phase 24 not complete

**Risk:** Phase 26 cannot consume Phase 24's executive state.

**Mitigation:** Phase 26 defines its own presence frame fields. When Phase 24
is complete, Phase 26 integrates its executive state.

### 8.2 Phase 25 not complete

**Risk:** Phase 26 cannot consume Phase 25's capability execution results.

**Mitigation:** Phase 26 defines its own embodiment cues. When Phase 25 is
complete, Phase 26 integrates its capability execution results.

### 8.3 Concurrent development conflict

**Risk:** Phase 24 or 25 changes their contracts while Phase 26 is in
development.

**Mitigation:** Phase 26 defines its own interfaces. Integration happens
only when dependencies are green.

### 8.4 Invented state creep

**Risk:** Phase 26 invents internal state (mood, emotion, mental state).

**Mitigation:** Phase 26 is bounded by the no-invented-state invariant. Any
internal state claim requires a PLAN.md update.

---

## 9. Dependency resolution order

Phase 26 implementation begins when:

1. Phase 25 (Digital Senses & Hands II) is complete
2. Phase 24 (Executive Intelligence) is complete
3. All predecessor dependencies are green
4. The owner approves the Electron alpha
5. PLAN.md Step G is satisfied

Until then, Phase 26 remains a preparation-only branch.
