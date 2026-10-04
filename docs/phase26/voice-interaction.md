# Phase 26 — Voice Interaction Expansion

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Phase 26 expands the voice interaction patterns with multi-turn capture,
voice session history, and bounded interaction patterns. All voice remains
local-only. No cloud services are added.

The core invariant:

> **Voice interactions are bounded, local-only, and derived from real Core
> state. Richer voice does not mean cloud services or always-on capture.**

---

## 2. Existing voice service (from Phase 3)

The existing voice service provides:
- Local-only transcription (no cloud)
- Local-only synthesis (no cloud)
- Bounded capture (30 seconds, 4 MB)
- Bounded transcript (8,000 characters)
- Explicit press-and-release capture
- No always-on mode or wake-word daemon

---

## 3. Voice interaction expansion

### 3.1 Multi-turn voice capture

Multiple captures in sequence, bounded to 4 captures per session.

**Constraints:**
- Maximum 4 captures per session
- Each capture is bounded (30 seconds, 4 MB)
- Captures are explicit (press-and-release)
- Captures are local-only

### 3.2 Voice session history

A bounded history of voice sessions, maximum 8 entries.

**Constraints:**
- Maximum 8 sessions in history
- Most recent session is last
- Derived from the event journal
- Rebuilt on restart

### 3.3 Voice interaction patterns

Bounded patterns for voice interactions:

| Pattern | Description |
|---|---|
| `push-to-talk` | Single explicit capture |
| `multi-turn` | Multiple captures in sequence |
| `voice-session` | A bounded sequence of captures and syntheses |

---

## 4. Voice session lifecycle

### 4.1 Creation

A voice session is created when:
1. A capture is started
2. The session is bounded (maximum 4 captures)
3. The session is journaled

### 4.2 Active

While active:
- Captures are counted
- Syntheses are counted
- The session is bounded

### 4.3 Completion

A voice session completes when:
- All captures are completed
- The session is journaled

### 4.4 Cancellation

A voice session is cancelled when:
- STOP ALL is activated
- The owner cancels it
- The session is journaled

---

## 5. Voice interaction constraints

### 5.1 Bounded captures

Every voice capture is bounded:
- Maximum 30 seconds
- Maximum 4 MB
- Maximum 8,000 characters transcript

### 5.2 Bounded sessions

Every voice session is bounded:
- Maximum 4 captures
- Maximum 8 syntheses
- Maximum 8 sessions in history

### 5.3 Local-only

All voice is local-only:
- No cloud transcription
- No cloud synthesis
- No network fallback

### 5.4 Explicit

All voice capture is explicit:
- Press-and-release
- No always-on mode
- No wake-word daemon

### 5.5 No persistent state

Voice interactions do not create persistent state:
- Audio is never stored
- Transcripts are never journalled
- Syntheses are never stored

---

## 6. Voice interaction and authority

### 6.1 Guard

Voice interactions are checked through Guard. A voice interaction cannot be
executed without Guard approval.

### 6.2 Governor

Voice interactions do not require cognition. They are deterministic and do
not call models.

### 6.3 STOP ALL

If STOP ALL is active, all voice interactions are refused.

### 6.4 Budgets

Voice interactions are checked against budgets. A voice interaction cannot
exceed the remaining budget.

### 6.5 Approvals

Voice interactions do not require approval. They are routine and do not
modify consequential state.

---

## 7. Voice interaction testing

Every voice interaction is tested deterministically:

- Same inputs = same outputs
- No wall-clock dependency
- No external service dependency
- No model call dependency
- Repeatable and auditable

### 7.1 Test cases

| Test | Description |
|---|---|
| `voice.capture.single` | Single push-to-talk capture |
| `voice.capture.multi-turn` | Multiple captures in sequence |
| `voice.capture.bounded` | Capture exceeds bound → refused |
| `voice.capture.local-only` | No cloud service is called |
| `voice.capture.explicit` | Capture is explicit (press-and-release) |
| `voice.session.bounded` | Session exceeds bound → refused |
| `voice.session.history` | Session history is bounded |
| `voice.session.local-only` | No cloud service is called |
| `voice.synthesis.local-only` | Synthesis is local-only |
| `voice.synthesis.bounded` | Synthesis exceeds bound → refused |

---

## 8. Test plan summary

See `docs/phase26/test-plan.md` for the full test plan.

---

## 9. Acceptance criteria summary

See `docs/phase26/acceptance-criteria.md` for full acceptance criteria.
