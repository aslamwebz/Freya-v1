# Phase 31 — Interruption and Preemption

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

The long-horizon subsystem can be interrupted at any time. Interruption is
immediate, deterministic, and journaled. The owner can always preempt any
autonomous long-horizon action.

---

## 2. Interruption sources

### 2.1 STOP ALL

**Priority:** Highest  
**Effect:** Immediately halts everything. No exceptions.  
**Scope:** All states, all goals, all cognition.  
**Recovery:** Only the owner can clear STOP ALL.

### 2.2 Owner command

**Priority:** High  
**Effect:** Preempts scheduled work. The owner's command is processed next.  
**Scope:** All autonomous long-horizon actions.  
**Recovery:** The preempted goal can be resumed after the owner's command.

### 2.3 Guard denial

**Priority:** Medium  
**Effect:** Stops the current goal action.  
**Scope:** The current goal only.  
**Recovery:** The goal can be retried if the Guard denial is resolved.

### 2.4 Budget exhaustion

**Priority:** Medium  
**Effect:** Stops the current goal action.  
**Scope:** The current goal only.  
**Recovery:** The goal can be retried when budget is available.

### 2.5 Deadline expiry

**Priority:** Low  
**Effect:** Stops the current goal action.  
**Scope:** The current goal only.  
**Recovery:** The goal can be retried if the deadline is extended.

### 2.6 Goal dependency unmet

**Priority:** Medium  
**Effect:** Blocks the goal from proceeding.  
**Scope:** The dependent goal only.  
**Recovery:** The goal can proceed when the dependency is met.

---

## 3. Interruption semantics

### 3.1 Immediate

Interruption is immediate. There is no grace period, no "finish what you're
doing", no "wait for the current step to complete". STOP ALL means stop.

### 3.2 Deterministic

Interruption is deterministic. Same state + same interruption = same result.

### 3.3 Journaled

Every interruption is journaled. The interruption is a durable event.

### 3.4 Recoverable

Interruption is recoverable. The interrupted goal can be resumed or retried.

---

## 4. Owner preemption

### 4.1 Preemption rules

1. **Owner commands always take priority** over scheduled tasks.
2. **Owner approval is required** for consequential actions.
3. **Owner can cancel** any autonomous long-horizon action.
4. **Owner can pause** the long-horizon subsystem.

### 4.2 Preemption outcomes

| Outcome | Description |
|---|---|
| `preempted` | The goal was preempted by the owner |
| `cancelled` | The goal was cancelled by the owner |
| `paused` | The goal was paused by the owner |

### 4.3 Preemption and the subsystem

When the owner preempts:
1. The current state transitions to `WAKING` (to process the owner's command)
2. The preempted goal is journaled
3. The subsystem processes the owner's command
4. After the owner's command, the subsystem can resume the preempted goal

---

## 5. Interruption and state machine

### 5.1 State transitions on interruption

| State | STOP ALL | Owner command | Guard denial | Budget exhaustion | Deadline expiry |
|---|---|---|---|---|---|
| `IDLE` | → `STOP` | → `WAKING` | → `IDLE` | → `IDLE` | → `IDLE` |
| `GOAL_ACTIVE` | → `STOP` | → `WAKING` | → `GOAL_PAUSED` | → `GOAL_PAUSED` | → `GOAL_FAILED` |
| `CHECKPOINT` | → `STOP` | → `WAKING` | → `GOAL_PAUSED` | → `GOAL_PAUSED` | → `GOAL_FAILED` |
| `GOAL_PAUSED` | → `STOP` | → `WAKING` | → `GOAL_PAUSED` | → `GOAL_PAUSED` | → `GOAL_PAUSED` |
| `GOAL_COMPLETE` | — | — | — | — | — |
| `GOAL_FAILED` | — | — | — | — | — |

### 5.2 STOP ALL is absolute

STOP ALL transitions any state to `STOP`. No exceptions. No grace period.

---

## 6. Interruption and cognition

### 6.1 Cognition interruption

Cognition can be interrupted by:
- STOP ALL
- Owner cancellation
- Provider timeout
- Budget exhaustion

### 6.2 Cognition interruption outcomes

| Outcome | Description |
|---|---|
| `cancelled` | The cognition was cancelled |
| `failed` | The cognition failed |
| `completed` | The cognition completed before interruption |

### 6.3 Cognition interruption and budget

If cognition is interrupted after the provider was contacted:
- The budget is not refunded
- The usage is recorded as `unknown`
- The grant is not restored

If cognition is interrupted before the provider was contacted:
- The budget is refunded
- No usage is recorded
- The grant is restored

---

## 7. Interruption and verification

### 7.1 Verification interruption

Verification can be interrupted by:
- STOP ALL
- Owner cancellation
- Deadline expiry

### 7.2 Verification interruption outcomes

| Outcome | Description |
|---|---|
| `interrupted` | The verification was interrupted |
| `failed` | The verification failed |
| `completed` | The verification completed before interruption |

---

## 8. Interruption guarantees

These guarantees must hold at all times:

1. **STOP ALL is immediate** — No grace period.
2. **Owner can always preempt** — No autonomous action is immune.
3. **Interruption is journaled** — No silent interruption.
4. **Interruption is recoverable** — The interrupted goal can be resumed.
5. **Interruption is deterministic** — Same state + same interruption = same result.
6. **No action runs forever** — Every action has a deadline.
7. **No hidden continuation** — Interrupted goals are not silently continued.
