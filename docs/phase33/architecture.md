# Phase 33 — Architecture Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Autonomous Enterprise / Webzone is the subsystem that enables Freya to operate
a owner-controlled business environment with explicit enterprise boundaries,
task/mission orchestration, web presence interfaces, auditability, approvals,
spending gates, external-action verification, and rollback/recovery. It extends
Long-Horizon Autonomy (Phase 31) and Economic Intelligence (Phase 32) to
operate a business environment.

The core invariant:

> **Autonomous Enterprise is owner-controlled business operation within explicit
> boundaries. Every action is authorized, auditable, and reversible. No hidden
> spending, no autonomous real-money actions, no authority widening.**

Every decision flows through existing authority paths (Guard, Governor,
STOP ALL, approvals, budgets). No new authority is created. No real-money
action is performed.

---

## 2. Design principles

### 2.1 Owner-controlled

The business environment is owned and controlled by the owner. The enterprise
subsystem operates within boundaries set by the owner. It does not set its own
boundaries.

### 2.2 Bounded operation

Every enterprise operation is bounded:
- A maximum number of tasks
- A maximum number of missions
- A maximum duration
- A deadline after which it stops
- A way to be interrupted by STOP ALL

### 2.3 Deterministic before cognitive

Every decision before a model call is deterministic: same state + same clock
= same result. This is testable, auditable, and safe.

### 2.4 Authority-preserving

The enterprise subsystem cannot:
- Create grants
- Widen budgets
- Bypass Guard
- Override Governor
- Clear STOP ALL
- Approve its own requests
- Perform real-money actions
- Add spending authority

### 2.5 Explainable

Every enterprise decision carries:
- What was decided
- Why it was decided
- What alternatives were considered
- What is uncertain
- What is blocked

### 2.6 Zero hidden spend

No model call without a wake. No continuous polling. No hidden reasoning.
No background processing. No self-scheduling timers.

### 2.7 Auditable

Every decision, action, and refusal is journaled. Every enterprise boundary
enforcement is journaled. Every spending gate check is journaled. Every
external-action verification is journaled. Every rollback is journaled.

---

## 3. Components

### 3.1 BusinessEnvironment (new, Phase 33)

Owner-controlled business environment stored in Vault. Each environment has:
- A unique identifier
- A state (draft, active, paused, completed, failed, cancelled)
- Explicit enterprise boundaries
- Business objectives
- Spending limits

**Responsibilities:**
- Create and update business environments
- Enforce enterprise boundaries
- Track business objectives
- Journal all environment changes

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Perform real-money actions

### 3.2 TaskMissionOrchestration (new, Phase 33)

Bounded orchestration of tasks and missions within enterprise boundaries.

**Responsibilities:**
- Orchestrate tasks within enterprise boundaries
- Orchestrate missions within enterprise boundaries
- Track task/mission progress
- Verify task/mission outcomes
- Journal all orchestration decisions

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Perform real-money actions

### 3.3 WebzoneInterfaces (new, Phase 33)

Bounded, auditable web presence and workzone interfaces.

**Responsibilities:**
- Provide bounded web presence interfaces
- Provide bounded workzone operations
- Enforce enterprise boundaries on all interfaces
- Journal all interface operations

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Perform real-money actions

### 3.4 EnterpriseStateMachine (new, Phase 33)

Manages the enterprise state transitions. Extends the Phase 31 long-horizon
state machine with enterprise-specific states.

**States:**
- `IDLE` — No active enterprise operation
- `ENV_ACTIVE` — A business environment is being operated
- `TASK_ACTIVE` — A task is being executed
- `MISSION_ACTIVE` — A mission is being executed
- `WEBZONE_ACTIVE` — A webzone operation is being performed
- `ENV_PAUSED` — An environment is paused
- `ENV_COMPLETE` — An environment is complete (terminal)
- `ENV_FAILED` — An environment has failed (terminal)

### 3.5 EnterpriseState (new, Phase 33)

The explainable enterprise state. Answers:
- What is being operated now
- Why it matters
- What is blocked
- What is uncertain
- Next bounded action

### 3.6 SpendingGates (new, Phase 33)

Explicit spending limits with hard ceilings.

**Responsibilities:**
- Enforce spending limits
- Check spending before every consequential action
- Journal all spending gate checks
- Refuse actions that exceed spending limits

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Widen spending limits

### 3.7 ExternalActionVerification (new, Phase 33)

Verification of external actions before they are considered complete.

**Responsibilities:**
- Verify external actions
- Confirm action outcomes
- Journal all verification outcomes
- Refuse unverified actions

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Fabricate verification outcomes

### 3.8 RollbackRecovery (new, Phase 33)

Bounded, explicit rollback and recovery for reversible actions.

**Responsibilities:**
- Roll back reversible actions
- Recover from failed actions
- Journal all rollback/recovery operations
- Enforce rollback limits

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Roll back irreversible actions

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
EnterpriseStateMachine.evaluate(environments)
    │
    ├─ no active environment → IDLE
    │
    ▼ active environment
SpendingGates.check(action)
    │
    ├─ exceeds limit → DENY (journaled)
    │
    ▼ within limit
Governor.evaluate(request)
    │
    ├─ deny → DENY (journaled)
    │
    ▼ allow
CognitionService.request(intent)
    │
    ├─ denied → DENY (journaled)
    ├─ failed → ENV_PAUSED (retry or fail)
    │
    ▼ allowed
TaskMissionOrchestration / WebzoneInterfaces
    │
    ▼
ExternalActionVerification
    │
    ├─ passed → continue or complete
    ├─ failed → ENV_FAILED (or retry)
    │
    ▼
Continuation decision
    │
    ├─ continue → ENV_ACTIVE (next step)
    ├─ pause → ENV_PAUSED
    ├─ complete → ENV_COMPLETE (terminal)
    ├─ fail → ENV_FAILED (terminal)
    ├─ rollback → RollbackRecovery
```

---

## 5. Integration with existing subsystems

### 5.1 Phase 31 — Long-Horizon Autonomy

The enterprise subsystem uses the long-horizon subsystem's persistent goals,
bounded scheduler and continuation state machine. It does not replace them;
it extends them with enterprise-specific states and transitions.

### 5.2 Phase 32 — Economic Intelligence

The enterprise subsystem uses the economic subsystem's research, simulation and
paper trading engines. It does not replace them; it extends them with
enterprise-specific operations.

### 5.3 Phase 23 — Continuous Life Loop

The enterprise subsystem uses the life loop's wake mechanism, pre-cognition
filter and continuation state machine. It does not replace them; it extends
them with enterprise-specific states and transitions.

### 5.4 Phase 24 — Executive Intelligence

The enterprise subsystem uses the executive layer's prioritization, planning
and coordination. It does not replace them; it extends them with enterprise
operation tracking.

### 5.5 Guard

The enterprise subsystem checks capabilities through `Guard.evaluate()`. It
does not bypass Guard.

### 5.6 Governor

The enterprise subsystem requests cognition through `Governor.evaluate()`.
It does not bypass Governor.

### 5.7 EventStore

The enterprise subsystem appends events through `EventFabric.append()`. It
does not create a parallel store.

### 5.8 Vault

The enterprise subsystem stores business environments, tasks, missions and
webzone data in Vault. It does not create new durable stores.

---

## 6. Boundaries

### 6.1 What the enterprise subsystem owns

- Business environment store
- Task/mission orchestration
- Webzone interfaces
- Enterprise state machine
- Enterprise state projection
- Spending gates
- External-action verification
- Rollback/recovery

### 6.2 What the enterprise subsystem does NOT own

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)
- Real-money actions (not owned by anyone — forbidden)

---

## 7. Failure modes

| Failure | Handling |
|---|---|
| Wake from unauthorized source | Denied, journaled |
| Pre-cognition filter denies | Denied, journaled |
| Governor denies | Denied, journaled |
| Provider fails | Environment failed, retry or fail |
| Verification fails | Environment failed or retry |
| Deadline expires | Terminal outcome |
| STOP ALL activated | Immediate halt |
| Journal corrupt | Deny everything |
| Restart during operation | Reconcile interrupted operation |
| Budget exhausted | Operation paused |
| Spending gate exceeded | Denied, journaled |
| External action unverified | Denied, journaled |
| Rollback fails | Environment failed |

---

## 8. Enterprise invariants

These invariants must hold at all times:

1. **No real money** — No real-money action is performed.
2. **No continuous reasoning** — Enterprise operations are pursued through discrete wakes.
3. **No hidden spend** — No model call without a wake.
4. **No authority widening** — Every action flows through existing authority.
5. **Deterministic** — Same state + same clock = same result.
6. **Event-sourced** — All state is derived from the journal.
7. **Explainable** — Every decision carries reasoning.
8. **Bounded** — Every operation has a deadline and completion criteria.
9. **Auditable** — Every decision, action, and refusal is journaled.
10. **Spending gates enforced** — No action exceeds spending limits.
11. **External actions verified** — No external action is considered complete without verification.
12. **Reversible actions rolled back** — Reversible actions can be rolled back.
