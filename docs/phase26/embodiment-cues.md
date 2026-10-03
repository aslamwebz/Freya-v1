# Phase 26 — Embodiment Cues

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Phase 26 adds bounded, code-owned embodiment cues derived from real Core
state. Every cue is derived from real Core state. No cue is invented.

The core invariant:

> **Embodiment cues are derived from real Core state, not invented. A cue
> is a projection of what Core knows, not a claim about what Freya is.**

---

## 2. Design principles

### 2.1 Derived, never invented

Every embodiment cue is derived from real Core state:
- Attention-derived cues (from attention directives)
- Work-derived cues (from work projection)
- Voice-derived cues (from voice capture/synthesis status)
- Personality-derived cues (from personality projection)

### 2.2 Bounded

Every cue has:
- A bounded label (maximum 128 characters)
- A bounded derivation source
- A bounded activation time

### 2.3 Code-owned

Every cue type is a code-owned label. A renderer may not invent a cue type.

### 2.4 Deterministic

Cue derivation is deterministic: same inputs = same cues.

---

## 3. Cue types

### 3.1 Attention-derived cues

| Cue Type | Derivation Source | Label |
|---|---|---|
| `attention-urgent` | Attention directive with urgent importance | "Something urgent needs you" |
| `attention-normal` | Attention directive with normal importance | "Something needs you" |

### 3.2 Work-derived cues

| Cue Type | Derivation Source | Label |
|---|---|---|
| `work-running` | Work projection with running runs | "A run is executing" |
| `work-waiting` | Work projection with waiting runs | "A run is waiting" |
| `work-approval` | Work projection with awaiting approval runs | "A run is waiting for your decision" |

### 3.3 Voice-derived cues

| Cue Type | Derivation Source | Label |
|---|---|---|
| `voice-listening` | Voice capture active | "Listening" |
| `voice-speaking` | Voice synthesis active | "Speaking" |

### 3.4 Personality-derived cues

| Cue Type | Derivation Source | Label |
|---|---|---|
| `personality-cue` | Personality projection with active cue | "Expressing a cue" |

---

## 4. Cue derivation

### 4.1 Derivation rules

A cue is derived when:
1. The derivation source is present
2. The derivation source matches the cue type
3. The cue is not already active

### 4.2 Derivation order

The derivation order is:
1. Attention-derived cues
2. Work-derived cues
3. Voice-derived cues
4. Personality-derived cues

### 4.3 Derivation constraints

- Maximum 8 active cues
- Most recent cue is last
- Derived from real Core state
- Deterministic

---

## 5. Cue lifecycle

### 5.1 Activation

A cue is activated when:
1. The derivation source is present
2. The cue is derived
3. The cue is added to the active cue list

### 5.2 Deactivation

A cue is deactivated when:
1. The derivation source is no longer present
2. The cue is removed from the active cue list

### 5.3 Expiry

A cue expires when:
1. The cue has been active for longer than the bounded duration
2. The cue is removed from the active cue list

---

## 6. Cue constraints

### 6.1 Bounded labels

Every cue label is bounded to 128 characters. A label that exceeds the bound
is refused, not truncated.

### 6.2 Bounded list

The active cue list is bounded to 8 cues. A cue that exceeds the bound is
refused, not added.

### 6.3 Code-owned types

Every cue type is a code-owned label. A renderer may not invent a cue type.

### 6.4 Deterministic derivation

Cue derivation is deterministic: same inputs = same cues.

---

## 7. Cue and authority

### 7.1 Guard

Cues are checked through Guard. A cue cannot be rendered without Guard
approval.

### 7.2 Governor

Cues do not require cognition. They are deterministic and do not call
models.

### 7.3 STOP ALL

If STOP ALL is active, all cues are deactivated.

### 7.4 Budgets

Cues are checked against budgets. A cue cannot exceed the remaining budget.

### 7.5 Approvals

Cues do not require approval. They are derived from real Core state and do
not modify consequential state.

---

## 8. Cue testing

Every cue is tested deterministically:

- Same inputs = same outputs
- No wall-clock dependency
- No external service dependency
- No model call dependency
- Repeatable and auditable

### 8.1 Test cases

| Test | Description |
|---|---|
| `cue.attention-urgent` | Urgent attention directive → cue activated |
| `cue.attention-normal` | Normal attention directive → cue activated |
| `cue.work-running` | Running run → cue activated |
| `cue.work-waiting` | Waiting run → cue activated |
| `cue.work-approval` | Awaiting approval run → cue activated |
| `cue.voice-listening` | Voice capture active → cue activated |
| `cue.voice-speaking` | Voice synthesis active → cue activated |
| `cue.personality-cue` | Personality cue active → cue activated |
| `cue.bounded` | Cue list exceeds 8 → oldest removed |
| `cue.deactivation` | Derivation source removed → cue deactivated |

---

## 9. Test plan summary

See `docs/phase26/test-plan.md` for the full test plan.

---

## 10. Acceptance criteria summary

See `docs/phase26/acceptance-criteria.md` for full acceptance criteria.
