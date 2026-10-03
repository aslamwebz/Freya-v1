# Phase 31 — Restart Continuity

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

The long-horizon subsystem must survive restarts without losing identity,
fabricating state, or silently continuing interrupted work. All state is
derived from the event journal. Recovery is deterministic.

---

## 2. Event-sourced recovery

### 2.1 Replay

On restart, the journal is replayed:
1. Read all events from the journal
2. Fold them into CoreState using `reduceCoreState`
3. Rebuild all subsystem state (Attention, Work, Missions, Long-Horizon, etc.)
4. Reconcile interrupted states
5. Resume or terminate explicitly

### 2.2 Deterministic

Replay is deterministic. Same journal = same state. There is no in-memory
truth that outlives the durable record.

### 2.3 Integrity

If the journal is corrupt:
- The corrupt segment is quarantined
- The trusted prefix is replayed
- The Core reports `degraded`
- Cognition is denied (fail-closed)

---

## 3. Interrupted goal recovery

### 3.1 Goal states at interruption

A goal that was in a non-terminal state when the process died:

| State at interruption | Recovery |
|---|---|
| `draft` | → `draft` (can be activated) |
| `active` | → `paused` (re-evaluate on next wake) |
| `paused` | → `paused` (can be resumed) |
| `completed` | → `completed` (already finished) |
| `failed` | → `failed` (already failed) |
| `cancelled` | → `cancelled` (already cancelled) |

### 3.2 Recovery rules

1. **An active goal is marked `paused`** — Its plan was in memory and is gone.
2. **A paused goal stays `paused`** — It can be resumed.
3. **A completed goal stays `completed`** — It finished before the interruption.
4. **A failed goal stays `failed`** — It already failed.
5. **A cancelled goal stays `cancelled`** — It was already cancelled.

### 3.3 Recovery and the subsystem

The subsystem does not automatically restart interrupted goals. The owner must
explicitly resume a paused goal to continue the work.

---

## 4. Interrupted checkpoint recovery

### 4.1 Checkpoint states at interruption

A checkpoint that was in a non-terminal state when the process died:

| State at interruption | Recovery |
|---|---|
| `pending` | → `pending` (can be started) |
| `in-progress` | → `failed` with reason `restartInterrupted` |
| `verified` | → `verified` (already finished) |
| `failed` | → `failed` (already failed) |

### 4.2 Recovery rules

1. **An in-progress checkpoint is marked `failed`** — It was interrupted.
2. **A pending checkpoint stays `pending`** — It can be started.
3. **A verified checkpoint stays `verified`** — It finished before the interruption.
4. **A failed checkpoint stays `failed`** — It already failed.

---

## 5. Pending schedule recovery

### 5.1 Schedule states at interruption

A schedule that was `pending` when the process died:

| Condition | Recovery |
|---|---|
| Text was in memory | → `cancelled` with reason `restart` |
| Text was lost | → `cancelled` with reason `content-unavailable` |

### 5.2 Recovery rules

1. **A pending schedule whose text was in memory is cancelled** — The text
   was in the previous process's memory and is gone.
2. **A pending schedule whose text was lost is cancelled** — The text was
   never durable.
3. **A fired schedule stays `fired`** — It completed before the interruption.
4. **A cancelled schedule stays `cancelled`** — It was already cancelled.

### 5.3 Recovery and the subsystem

The subsystem does not automatically re-register cancelled schedules. The owner
must explicitly re-register a schedule.

---

## 6. Grant recovery

### 6.1 Grant states at interruption

Grants are durable (in the journal). On replay:

| Condition | Recovery |
|---|---|
| Not expired, not revoked | → Active |
| Expired | → Not active |
| Revoked | → Not active |

### 6.2 Recovery rules

1. **Expired grants are not active** — They cannot be used.
2. **Revoked grants are not active** — They cannot be used.
3. **Remaining budgets are preserved** — The budget arithmetic is replayed.
4. **Usage is preserved** — The usage totals are replayed.

### 6.3 Recovery and the subsystem

The subsystem uses the replayed grant state. It does not create new grants.

---

## 7. Interrupted action recovery

### 7.1 Action states at interruption

An action that was `running` when the process died:

| State at interruption | Recovery |
|---|---|
| `running` | → `failed` with reason `restartInterrupted` |
| `completed` | → `completed` (already finished) |
| `failed` | → `failed` (already failed) |
| `cancelled` | → `cancelled` (already cancelled) |

### 7.2 Recovery rules

1. **A running action is marked `failed`** — It was interrupted.
2. **A completed action stays `completed`** — It finished before the interruption.
3. **A failed action stays `failed`** — It already failed.
4. **A cancelled action stays `cancelled`** — It was already cancelled.

---

## 8. Recovery and the subsystem

### 8.1 Subsystem state recovery

The subsystem's state machine is derived from the event journal. On restart:

| State at interruption | Recovery |
|---|---|
| `IDLE` | → `IDLE` |
| `GOAL_ACTIVE` | → `GOAL_PAUSED` (re-evaluate on next wake) |
| `CHECKPOINT` | → `GOAL_PAUSED` (checkpoint was interrupted) |
| `GOAL_PAUSED` | → `GOAL_PAUSED` (can be resumed) |
| `GOAL_COMPLETE` | → `GOAL_COMPLETE` (already finished) |
| `GOAL_FAILED` | → `GOAL_FAILED` (already failed) |

### 8.2 Recovery guarantees

1. **No silent continuation** — The subsystem does not silently continue interrupted work.
2. **No fabricated state** — All state is derived from the journal.
3. **No lost events** — All events are durable.
4. **Deterministic recovery** — Same journal = same recovery.
5. **Fail-closed** — Corrupt journal denies everything.

---

## 9. Recovery and STOP ALL

### 9.1 STOP ALL survives restart

STOP ALL is a durable latch. It survives restart. On restart:
- If STOP ALL was active, it is still active.
- The subsystem does not resume until STOP ALL is cleared.
- Only the owner can clear STOP ALL.

### 9.2 STOP ALL recovery

On restart with STOP ALL active:
1. Replay the journal
2. Rebuild CoreState (STOP ALL is active)
3. Deny all cognition
4. Halt the subsystem
5. Wait for owner to clear STOP ALL

---

## 10. Recovery and multi-day goals

### 10.1 Multi-day goal recovery

A multi-day goal that was active when the process died:
1. The goal is marked `paused`
2. The goal's checkpoints are reconciled
3. The goal's progress is preserved
4. The goal's dependencies are re-evaluated
5. The goal is visible to the owner

### 10.2 Multi-day goal continuation

The owner may resume a paused multi-day goal:
1. The goal's state transitions to `active`
2. The goal's next checkpoint is identified
3. The goal continues from where it left off
4. The continuation is journaled

---

## 11. Restart continuity guarantees

These guarantees must hold at all times:

1. **Goals survive restarts** — All goal state is durable.
2. **Checkpoints survive restarts** — All checkpoint state is durable.
3. **Schedules survive restarts** — All schedule state is durable.
4. **Grants survive restarts** — All grant state is durable.
5. **STOP ALL survives restarts** — STOP ALL is a durable latch.
6. **No silent continuation** — Interrupted work is not silently continued.
7. **No fabricated state** — All state is derived from the journal.
8. **Deterministic recovery** — Same journal = same recovery.
