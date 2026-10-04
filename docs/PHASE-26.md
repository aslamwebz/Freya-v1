# Phase 26 — Natural Presence

**Status:** PREPARATION ONLY — NOT PRODUCTION
**Branch:** `prep/phase24-executive` (continuation)
**Blocked on:** Owner alpha gate (PLAN.md Step G)
**Required outcome:** richer natural voice/presence/embodiment without inventing internal state

---

## 1. What this document is

This is a **preparation specification** for Phase 26. It defines the architecture,
interfaces, test plans, red-team cases and acceptance criteria for Natural
Presence. It does **not** implement production runtime behavior.

**Phase 26 cannot start until Phase 25 is complete and the owner explicitly
approves the Electron alpha** after Vault + Phase21 + Phase22 + final Phase20 +
real UI/Core wiring (PLAN.md Step G). This branch exists so that when the gate
passes, implementation can begin immediately without re-deriving the design.

---

## 2. The core invariant

> **Presence is a projection of real Core state, not an invention of internal
> state. Richer presence does not mean richer claims about what Freya is.**

Phase 26 expands the richness and naturalness of Freya's presence — her voice,
her embodiment, her transitions — without inventing internal state. Every
presence state, animation, cue and transition is derived from real Core state.
No mood, no emotion, no mental state is claimed.

---

## 3. Scope

Phase 26 delivers:

1. **Richer presence transitions** — smoother, more natural transitions
   between presence states, derived from real Core state
2. **Expanded voice interactions** — more natural voice capture, transcription,
   and synthesis patterns, all local-only
3. **Embodiment cues** — bounded, code-owned cues derived from real Core state
   (attention, work, voice, personality)
4. **Presence frame expansion** — additional bounded fields in the presence
   frame, all derived from real Core state
5. **No invented internal state** — no mood, no emotion, no mental state, no
   personality claim that is not derived from real Core state
6. **No new authority** — every presence change flows through Guard, Governor,
   STOP ALL, approvals and budgets

---

## 4. What Phase 26 explicitly does NOT do

- Does NOT invent internal state (mood, emotion, mental state)
- Does NOT claim personality traits not derived from real Core state
- Does NOT add unrestricted screenshots or global screen capture
- Does NOT add unrestricted mouse/keyboard computer control
- Does NOT add any new authority
- Does NOT bypass Guard, Governor, STOP ALL, approvals or budgets
- Does NOT change PLAN.md
- Does NOT merge to main
- Does NOT bypass the alpha gate
- Does NOT add cloud-based voice services
- Does NOT add always-on voice capture

---

## 5. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                      NATURAL PRESENCE                              │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐     │
│  │  PRESENCE    │  │    VOICE     │  │   EMBODIMENT         │     │
│  │  STATE       │  │  INTERACTION │  │   CUES               │     │
│  │              │  │              │  │                      │     │
│  │ 8 states     │  │ capture      │  │ attention-derived    │     │
│  │ transitions  │  │ transcribe   │  │ work-derived         │     │
│  │ animations   │  │ synthesize   │  │ voice-derived        │     │
│  │              │  │              │  │ personality-derived  │     │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘     │
│         │                 │                      │                  │
│         └────────┬────────┘                      │                  │
│                  │                              │                  │
│         ┌────────┴──────────────────────────────┴────────┐        │
│         │           EXISTING AUTHORITY BOUNDARIES        │        │
│         │  Guard │ Governor │ STOP ALL │ Approvals │ Budgets      │
│         └─────────────────────────────────────────────────────────┘  │
│                                                                      │
│  NO new authority. NO invented internal state. NO hidden inference. │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Component details

### 6.1 Presence State Machine (expanded, Phase 26)

The existing 8 presence states are preserved. Phase 26 adds:
- Smoother transitions between states
- Bounded transition durations
- Transition history (bounded)

**No new states are added.** The 8 states are canonical.

### 6.2 Voice Interaction (expanded, Phase 26)

The existing local-only voice service is preserved. Phase 26 adds:
- Multi-turn voice capture (bounded)
- Voice session history (bounded)
- Voice interaction patterns (bounded)

**All voice remains local-only.** No cloud services.

### 6.3 Embodiment Cues (new, Phase 26)

Bounded, code-owned cues derived from real Core state:
- Attention-derived cues (from attention directives)
- Work-derived cues (from work projection)
- Voice-derived cues (from voice capture/synthesis status)
- Personality-derived cues (from personality projection)

**No cues are invented.** Every cue is derived from real Core state.

### 6.4 Presence Frame (expanded, Phase 26)

The existing presence frame is preserved. Phase 26 adds:
- Transition history (bounded)
- Embodiment cues (bounded)
- Voice session history (bounded)

**All new fields are derived from real Core state.**

---

## 7. Authority preservation

Every presence change flows through:
1. Guard capability check
2. Governor cognition authorization (if cognition is needed)
3. STOP ALL latch check
4. Budget remaining check
5. Approval requirement check

No component can bypass any of these.

---

## 8. Test plan summary

See `docs/phase26/test-plan.md` for the full test plan.

Key test categories:
1. Unit tests — presence state machine, voice interaction, embodiment cues
2. Integration tests — full presence frame flow
3. Red-team tests — authority escalation attempts
4. Zero-idle-inference tests — no model call without wake
5. No-invented-state tests — no mood, emotion, or mental state claims

---

## 9. Acceptance criteria summary

See `docs/phase26/acceptance-criteria.md` for full acceptance criteria.

Key criteria:
1. No continuous polling or hidden reasoning
2. Every wake is from an authorized source
3. Every cognition is gated by Governor
4. Every action is bounded and verifiable
5. STOP ALL immediately halts everything
6. Restart recovery is deterministic
7. Zero idle inference is proven
8. No authority escalation from any input
9. No invented internal state
10. All presence states derived from real Core state

---

## 10. Document index

| Document | Purpose |
|---|---|
| `docs/phase26/architecture.md` | Architecture specification |
| `docs/phase26/interfaces.md` | Compile-time types/interfaces |
| `docs/phase26/presence-state-machine.md` | Presence state machine expansion |
| `docs/phase26/voice-interaction.md` | Voice interaction expansion |
| `docs/phase26/embodiment-cues.md` | Embodiment cues |
| `docs/phase26/presence-frame.md` | Presence frame expansion |
| `docs/phase26/test-plan.md` | Test plan |
| `docs/phase26/red-team-cases.md` | Red-team cases |
| `docs/phase26/acceptance-criteria.md` | Acceptance criteria |
| `docs/phase26/dependency-map.md` | Dependency map |

---

## 11. NOT PRODUCTION — blocked on owner alpha gate

This entire branch is **preparation only**. No production runtime behavior is
implemented. No code in this branch activates runtime behavior. The branch
contains only documentation, specifications, interfaces and test plans.

**Phase 26 implementation begins only when:**
1. Phase 25 is complete
2. The owner explicitly approves the Electron alpha
3. Vault + Phase21 + Phase22 + final Phase20 + real UI/Core wiring are complete
4. The owner's manual test passes
5. PLAN.md Step G is satisfied

Until then, this branch is **blocked** and must not be merged to main.
