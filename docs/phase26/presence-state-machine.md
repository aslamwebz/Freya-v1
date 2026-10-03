# Phase 26 — Presence State Machine Expansion

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Phase 26 expands the presence state machine with smoother, more natural
transitions between the existing 8 presence states. No new states are added.
Every transition is derived from real Core state.

The core invariant:

> **Presence transitions are derived from real Core state, not invented by
> a renderer. Smoother transitions do not mean richer claims about what Freya
> is.**

---

## 2. Existing presence states (from Phase 13)

The 8 presence states are canonical:

| State | Meaning |
|---|---|
| `idle` | Nothing is happening |
| `listening` | A microphone is open |
| `thinking` | A provider call is in flight |
| `speaking` | A synthesis engine is producing audio |
| `working` | A Run is executing |
| `attention` | Core chose to cue |
| `error` | STOP ALL or integrity corrupt |
| `degraded` | A subsystem has faulted |

---

## 3. Transition expansion

### 3.1 New transitions

Phase 26 adds smoother transitions between states:

| From | To | Reason |
|---|---|---|
| `idle` | `listening` | Voice capture started |
| `listening` | `thinking` | Capture ended, cognition requested |
| `thinking` | `speaking` | Synthesis started |
| `speaking` | `idle` | Synthesis ended |
| `working` | `attention` | Attention directive received |
| `attention` | `idle` | Attention directive cleared |
| `error` | `idle` | STOP ALL deactivated |
| `degraded` | `idle` | Fault cleared |

### 3.2 Transition constraints

- Transitions are bounded: maximum 5 seconds
- Transitions are derived from real Core state
- Transitions are journaled
- Transitions are deterministic

### 3.3 Transition history

The transition history is bounded to 16 entries. The most recent transition
is last. The history is derived from the event journal.

---

## 4. Transition derivation

### 4.1 Derivation order

The derivation order is preserved from Phase 13:

1. **STOP ALL** → `error`
2. **Integrity corrupt** → `error`
3. **Degraded** → `degraded`
4. **Voice synthesis active** → `speaking`
5. **Voice capture active** → `listening`
6. **Provider call in flight** → `working`
7. **Run executing** → `working`
8. **Attention directive** → `attention`
9. **Personality cue** → `attention`
10. **Idle** → `idle`

### 4.2 Transition triggers

A transition is triggered when:
- A Core state change occurs
- The derivation order produces a different state
- The transition is legal (in the transition table)

### 4.3 Transition duration

A transition has a maximum duration of 5 seconds. If the transition takes
longer, it is marked as timed out and the state is set to the target state.

---

## 5. Transition history

### 5.1 Structure

The transition history is a bounded list of transitions:

```typescript
interface TransitionHistory {
  readonly transitions: readonly PresenceTransition[]
  readonly maxEntries: number
}
```

### 5.2 Properties

- Maximum 16 entries
- Most recent transition is last
- Derived from the event journal
- Rebuilt on restart

### 5.3 Lifecycle

1. **Created** — when a transition occurs
2. **Active** — used in presence frame rendering
3. **Expired** — when the history exceeds 16 entries

---

## 6. Transition and authority

### 6.1 Guard

Transitions are checked through Guard. A transition cannot be rendered
without Guard approval.

### 6.2 Governor

Transitions do not require cognition. They are deterministic and do not
call models.

### 6.3 STOP ALL

If STOP ALL is active, all transitions are refused and the state is `error`.

### 6.4 Budgets

Transitions are checked against budgets. A transition cannot exceed the
remaining budget.

### 6.5 Approvals

Transitions do not require approval. They are derived from real Core state
and do not modify consequential state.

---

## 7. Transition testing

Every transition is tested deterministically:

- Same inputs = same outputs
- No wall-clock dependency
- No external service dependency
- No model call dependency
- Repeatable and auditable

### 7.1 Test cases

| Test | Description |
|---|---|
| `transition.idle-to-listening` | Voice capture started |
| `transition.listening-to-thinking` | Capture ended, cognition requested |
| `transition.thinking-to-speaking` | Synthesis started |
| `transition.speaking-to-idle` | Synthesis ended |
| `transition.working-to-attention` | Attention directive received |
| `transition.attention-to-idle` | Attention directive cleared |
| `transition.error-to-idle` | STOP ALL deactivated |
| `transition.degraded-to-idle` | Fault cleared |
| `transition.illegal` | Illegal transition → refused |
| `transition.timeout` | Transition exceeds duration → timed out |
| `transition.history-bounded` | History exceeds 16 entries → oldest removed |

---

## 8. Test plan summary

See `docs/phase26/test-plan.md` for the full test plan.

---

## 9. Acceptance criteria summary

See `docs/phase26/acceptance-criteria.md` for full acceptance criteria.
