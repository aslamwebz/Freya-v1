# Phase 26 — Presence Frame Expansion

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Phase 26 expands the presence frame with additional bounded fields derived
from real Core state. All new fields are derived from real Core state. No
field is invented.

The core invariant:

> **The presence frame is a projection of real Core state, not an invention
> of internal state. A richer frame does not mean richer claims about what
> Freya is.**

---

## 2. Existing presence frame (from Phase 13)

The existing presence frame provides:
- `schemaVersion` — schema version
- `state` — presence state
- `animation` — animation name
- `stateSince` — epoch ms when state was entered
- `detail` — short human line
- `voiceCapture` — voice capture status
- `voiceSynthesis` — voice synthesis status
- `attention` — attention directive
- `personalityCue` — personality cue
- `work` — work summary
- `sequence` — Core event sequence

---

## 3. Presence frame expansion

### 3.1 New fields

Phase 26 adds:
- `transitionHistory` — bounded list of recent transitions
- `embodimentCues` — bounded list of active embodiment cues
- `voiceSessionHistory` — bounded list of recent voice sessions

### 3.2 Field constraints

| Field | Type | Max Entries | Derivation Source |
|---|---|---|---|
| `transitionHistory` | `TransitionHistory` | 16 | Event journal |
| `embodimentCues` | `EmbodimentCueList` | 8 | Real Core state |
| `voiceSessionHistory` | `VoiceSessionHistory` | 8 | Event journal |

### 3.3 Field properties

- All new fields are derived from real Core state
- All new fields are bounded
- All new fields are deterministic
- All new fields are rebuilt on restart

---

## 4. Presence frame lifecycle

### 4.1 Creation

A presence frame is created when:
1. A Core state change occurs
2. The presence state is derived
3. The frame is built from real Core state

### 4.2 Update

A presence frame is updated when:
- A Core state change occurs
- The presence state is re-derived
- The frame is rebuilt from real Core state

### 4.3 Expiry

A presence frame expires when:
- The Core state change is older than the bounded duration
- The frame is rebuilt from real Core state

---

## 5. Presence frame and authority

### 5.1 Guard

Presence frames are checked through Guard. A presence frame cannot be
rendered without Guard approval.

### 5.2 Governor

Presence frames do not require cognition. They are deterministic and do not
call models.

### 5.3 STOP ALL

If STOP ALL is active, the presence state is `error` and the frame is
rebuilt.

### 5.4 Budgets

Presence frames are checked against budgets. A presence frame cannot exceed
the remaining budget.

### 5.5 Approvals

Presence frames do not require approval. They are derived from real Core
state and do not modify consequential state.

---

## 6. Presence frame testing

Every presence frame is tested deterministically:

- Same inputs = same outputs
- No wall-clock dependency
- No external service dependency
- No model call dependency
- Repeatable and auditable

### 6.1 Test cases

| Test | Description |
|---|---|
| `frame.creation` | Frame is created from real Core state |
| `frame.update` | Frame is updated from real Core state |
| `frame.expiry` | Frame expires after bounded duration |
| `frame.transition-history` | Transition history is bounded |
| `frame.embodiment-cues` | Embodiment cues are bounded |
| `frame.voice-session-history` | Voice session history is bounded |
| `frame.stop-all` | STOP ALL → error state |
| `frame.degraded` | Degraded → degraded state |
| `frame.no-invented-state` | No mood, emotion, or mental state claims |

---

## 7. Test plan summary

See `docs/phase26/test-plan.md` for the full test plan.

---

## 8. Acceptance criteria summary

See `docs/phase26/acceptance-criteria.md` for full acceptance criteria.
