# Phase 31 — Architecture Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Long-Horizon Autonomy is the subsystem that enables Freya to pursue multi-day
and multi-week goals across restarts, events and interruptions without hidden
continuous spend. It extends the Continuous Life Loop (Phase 23) and Executive
Intelligence (Phase 24) to span longer horizons.

The core invariant:

> **Long-horizon autonomy is bounded continuation, not continuous reasoning.
> A multi-day goal is pursued through discrete, authorized, verifiable wakes —
> never through hidden continuous spend.**

Every decision flows through existing authority paths (Guard, Governor,
STOP ALL, approvals, budgets). No new authority is created.

---

## 2. Design principles

### 2.1 Bounded continuation

Long-horizon goals are pursued through discrete, bounded wakes. There is no
continuous reasoning loop, no background polling, no hidden model call. Each
wake is deterministic, authorized and verifiable.

### 2.2 Event-sourced

All long-horizon state is derived from the event journal. On restart:
1. Replay the journal
2. Rebuild long-horizon state
3. Reconcile interrupted goals
4. Resume or terminate explicitly

### 2.3 Deterministic before cognitive

Every decision before a model call is deterministic: same state + same clock
= same result. This is testable, auditable, and safe.

### 2.4 Authority-preserving

The long-horizon subsystem cannot:
- Create grants
- Widen budgets
- Bypass Guard
- Override Governor
- Clear STOP ALL
- Approve its own requests
- Add real-money/economic actions

### 2.5 Explainable

Every long-horizon decision carries:
- What was decided
- Why it was decided
- What alternatives were considered
- What is uncertain
- What is blocked

### 2.6 Zero hidden spend

No model call without a wake. No continuous polling. No hidden reasoning.
No background processing. No self-scheduling timers.

---

## 3. Components

### 3.1 PersistentGoalStore (new, Phase 31)

Durable multi-day/multi-week goals stored in Vault. Each goal has:
- A unique identifier
- A state (draft, active, paused, completed, failed, cancelled)
- Explicit completion criteria
- Progress tracking
- Dependencies on other goals
- A deadline (optional)

**Responsibilities:**
- Create and update goals
- Track progress toward completion criteria
- Detect goal state transitions
- Journal all goal changes

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Create new durable stores

### 3.2 BoundedScheduler (new, Phase 31)

Deterministic, host-driven wake evaluation for long-horizon continuation.
Extends the Phase 23 heartbeat mechanism.

**Responsibilities:**
- Evaluate registered schedules
- Fire schedules when due and conditions hold
- Enforce schedule limits (max 64, max 8 repeats, min 60s interval)
- Enforce max horizon (30 days)

**Does NOT:**
- Call a model
- Self-schedule
- Create new wake sources

### 3.3 LongHorizonContinuation (new, Phase 31)

Manages multi-day goal spans with explicit checkpoints. Ensures that:
- Each checkpoint is verified before continuing
- Interrupted goals are reconciled on restart
- Goal progress is tracked and explainable
- Uncertainty is surfaced

**Responsibilities:**
- Manage goal spans across wakes
- Verify checkpoint outcomes
- Reconcile interrupted goals
- Surface uncertainty

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard

### 3.4 LongHorizonStateMachine (new, Phase 31)

Manages the long-horizon state transitions. Extends the Phase 23 continuation
state machine with long-horizon-specific states.

**States:**
- `IDLE` — No active long-horizon goal
- `GOAL_ACTIVE` — A goal is being pursued
- `CHECKPOINT` — A checkpoint is being verified
- `GOAL_PAUSED` — A goal is paused
- `GOAL_COMPLETE` — A goal is complete (terminal)
- `GOAL_FAILED` — A goal has failed (terminal)

### 3.5 LongHorizonState (new, Phase 31)

The explainable long-horizon state. Answers:
- What is being pursued now
- Why it matters
- What is blocked
- What is uncertain
- Next bounded action

---

## 4. Data flow

```
Wake event
    │
    ▼
WakeSourceRegistry.validate(wake)
    │
    ├─ invalid → DENY (journaled)
    │
    ▼ valid
BoundedScheduler.evaluate(schedules)
    │
    ├─ no schedule due → IDLE
    │
    ▼ schedule fired
PreCognitionFilter.evaluate(wake, state)
    │
    ├─ deny → DENY (journaled)
    ├─ wait → WAIT (journaled, with deadline)
    │
    ▼ allow
LongHorizonContinuation.evaluate(goals)
    │
    ├─ no active goal → IDLE
    │
    ▼ active goal
Governor.evaluate(request)
    │
    ├─ deny → DENY (journaled)
    │
    ▼ allow
CognitionService.request(intent)
    │
    ├─ denied → DENY (journaled)
    ├─ failed → CHECKPOINT (retry or fail)
    │
    ▼ allowed
WorkEngine / MissionEngine / WorkforceEngine
    │
    ▼
Verification
    │
    ├─ passed → CHECKPOINT (continue or complete)
    ├─ failed → GOAL_FAILED (or retry)
    │
    ▼
Continuation decision
    │
    ├─ continue → GOAL_ACTIVE (next checkpoint)
    ├─ pause → GOAL_PAUSED
    ├─ complete → GOAL_COMPLETE (terminal)
    ├─ fail → GOAL_FAILED (terminal)
```

---

## 5. Integration with existing subsystems

### 5.1 Phase 23 — Continuous Life Loop

The long-horizon subsystem uses the life loop's wake mechanism, pre-cognition
filter and continuation state machine. It does not replace them; it extends
them with long-horizon-specific states and transitions.

### 5.2 Phase 24 — Executive Intelligence

The long-horizon subsystem uses the executive layer's prioritization, planning
and coordination. It does not replace them; it extends them with long-horizon
goal tracking.

### 5.3 Phase 7 — Missions

The long-horizon subsystem uses Missions as the execution vehicle for
long-horizon goals. A long-horizon goal may have child Missions.

### 5.4 Phase 6 — Work

The long-horizon subsystem uses WorkEngine for bounded execution. It does not
create new work paths.

### 5.5 Phase 8 — Workforce

The long-horizon subsystem uses WorkforceEngine for bounded delegation. It does
not create new delegation paths.

### 5.6 Guard

The long-horizon subsystem checks capabilities through `Guard.evaluate()`. It
does not bypass Guard.

### 5.7 Governor

The long-horizon subsystem requests cognition through `Governor.evaluate()`.
It does not bypass Governor.

### 5.8 EventStore

The long-horizon subsystem appends events through `EventFabric.append()`. It
does not create a parallel store.

### 5.9 Vault

The long-horizon subsystem stores persistent goals in Vault. It does not create
new durable stores.

---

## 6. Boundaries

### 6.1 What the long-horizon subsystem owns

- Persistent goal store
- Bounded scheduler
- Long-horizon continuation state machine
- Long-horizon state projection

### 6.2 What the long-horizon subsystem does NOT own

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)

---

## 7. Failure modes

| Failure | Handling |
|---|---|
| Wake from unauthorized source | Denied, journaled |
| Pre-cognition filter denies | Denied, journaled |
| Governor denies | Denied, journaled |
| Provider fails | Checkpoint failed, retry or fail |
| Verification fails | Goal failed or retry |
| Deadline expires | Terminal outcome |
| STOP ALL activated | Immediate halt |
| Journal corrupt | Deny everything |
| Restart during goal | Reconcile interrupted goal |
| Budget exhausted | Goal paused |
| Goal dependency unmet | Goal blocked |

---

## 8. Long-horizon invariants

These invariants must hold at all times:

1. **No continuous reasoning** — Long-horizon goals are pursued through discrete wakes.
2. **No hidden spend** — No model call without a wake.
3. **No authority widening** — Every action flows through existing authority.
4. **No real-money actions** — No economic actions are performed.
5. **Deterministic** — Same state + same clock = same result.
6. **Event-sourced** — All state is derived from the journal.
7. **Explainable** — Every decision carries reasoning.
8. **Bounded** — Every goal has a deadline and completion criteria.
