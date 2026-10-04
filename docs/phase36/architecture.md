# Phase 36 — Architecture Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Resilience & Self-Recovery is the subsystem that enables Freya to recover from
crash, data failure, provider failure, perform backup restore, operate
truthfully in degraded mode, and execute authorized repair workflows. It
extends the existing event-sourced recovery architecture (Phases 9, 23, 31)
to handle these failure modes.

The core invariant:

> **Resilience is bounded recovery, not continuous self-repair. Every recovery
> is authorized, auditable, and reversible. No hidden self-modification, no
> authority widening, no autonomous real-money actions.**

Every decision flows through existing authority paths (Guard, Governor,
STOP ALL, approvals, budgets). No new authority is created. No real-money
action is performed. No trusted runtime code is self-modified.

---

## 2. Design principles

### 2.1 Bounded recovery

Every recovery is bounded:
- A maximum number of recovery attempts
- A maximum recovery duration
- A deadline after which recovery stops
- A way to be interrupted by STOP ALL

### 2.2 Deterministic before cognitive

Every decision before a model call is deterministic: same state + same clock
= same result. This is testable, auditable, and safe.

### 2.3 Authority-preserving

The resilience subsystem cannot:
- Create grants
- Widen budgets
- Bypass Guard
- Override Governor
- Clear STOP ALL
- Approve its own requests
- Perform real-money actions
- Self-modify trusted runtime code

### 2.4 Explainable

Every resilience decision carries:
- What was decided
- Why it was decided
- What alternatives were considered
- What is uncertain
- What is blocked

### 2.5 Zero hidden spend

No model call without a wake. No continuous polling. No hidden reasoning.
No background processing. No self-scheduling timers.

### 2.6 Auditable

Every recovery, backup, restore, and repair is journaled. Every degraded-mode
transition is journaled. Every self-modification attempt is journaled.

### 2.7 No self-modification

The resilience subsystem never modifies trusted runtime code. It never
widens its own authority. It never performs hidden self-repair.

---

## 3. Components

### 3.1 CrashRecovery (new, Phase 36)

Bounded, deterministic recovery from process crashes.

**Responsibilities:**
- Detect process crash on restart
- Rebuild state from event journal
- Reconcile interrupted operations
- Resume or terminate explicitly

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Self-modify trusted runtime code

### 3.2 DataFailureRecovery (new, Phase 36)

Bounded recovery from data corruption/loss.

**Responsibilities:**
- Detect data corruption
- Quarantine corrupt data
- Replay trusted prefix
- Report degraded mode

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Self-modify trusted runtime code

### 3.3 ProviderFailureRecovery (new, Phase 36)

Bounded recovery from model provider failures.

**Responsibilities:**
- Detect provider failure
- Fall back to owner-approved provider
- Retry with backoff
- Report provider status

**Does NOT:**
- Call a model for deterministic recovery
- Create authority
- Bypass Guard
- Add new providers

### 3.4 BackupRestore (new, Phase 36)

Bounded, auditable backup and restore.

**Responsibilities:**
- Create encrypted backups
- Verify backup integrity
- Restore from encrypted backup
- Validate restored state

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Store backups outside encrypted storage

### 3.5 DegradedModeHonesty (new, Phase 36)

Truthful degraded-mode operation.

**Responsibilities:**
- Detect degraded-mode conditions
- Report degraded-mode state truthfully
- Never fabricate capability
- Never hide degradation

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Fabricate capability

### 3.6 RepairWorkflows (new, Phase 36)

Bounded, authorized repair workflows.

**Responsibilities:**
- Detect repairable conditions
- Request owner approval for consequential repairs
- Execute bounded repairs
- Verify repair outcomes

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Self-modify trusted runtime code
- Perform unauthorized repairs

### 3.7 ResilienceStateMachine (new, Phase 36)

Manages the resilience state transitions.

**States:**
- `HEALTHY` — Normal operation
- `DEGRADED` — Operating with reduced capability
- `RECOVERING` — Recovery in progress
- `REPAIRING` — Repair in progress
- `FAILED` — Unrecoverable failure (terminal)

### 3.8 ResilienceState (new, Phase 36)

The explainable resilience state. Answers:
- What is being recovered now
- Why it matters
- What is blocked
- What is uncertain
- Next bounded action

---

## 4. Data flow

```
Failure event (crash / data / provider)
    │
    ▼
FailureDetection.detect(failure)
    │
    ├─ no failure → HEALTHY
    │
    ▼ failure detected
ResilienceStateMachine.evaluate(failure)
    │
    ├─ recoverable → RECOVERING
    ├─ repairable → REPAIRING
    ├─ degraded → DEGRADED
    ├─ unrecoverable → FAILED (terminal)
    │
    ▼
RecoveryAction.execute(recovery)
    │
    ├─ success → HEALTHY
    ├─ partial → DEGRADED
    ├─ failed → REPAIRING or FAILED
    │
    ▼
Verification
    │
    ├─ passed → HEALTHY (or DEGRADED)
    ├─ failed → REPAIRING or FAILED
    │
    ▼
Continuation decision
    │
    ├─ continue → HEALTHY
    ├─ degrade → DEGRADED
    ├─ repair → REPAIRING
    ├─ fail → FAILED (terminal)
```

---

## 5. Integration with existing subsystems

### 5.1 Phase 9 — Context Awareness + Encrypted Restart Recovery

The resilience subsystem uses Phase 9's encrypted restart recovery
architecture. It extends it with crash/data/provider failure recovery.

### 5.2 Phase 23 — Continuous Life Loop

The resilience subsystem uses the life loop's wake mechanism and continuation
state machine. It extends it with resilience-specific states.

### 5.3 Phase 31 — Long-Horizon Autonomy

The resilience subsystem uses the long-horizon subsystem's event-sourced
recovery and restart continuity. It extends it with crash/data/provider
failure recovery.

### 5.4 Guard

The resilience subsystem checks capabilities through `Guard.evaluate()`. It
does not bypass Guard.

### 5.5 Governor

The resilience subsystem requests cognition through `Governor.evaluate()`.
It does not bypass Governor.

### 5.6 EventStore

The resilience subsystem appends events through `EventFabric.append()`. It
does not create a parallel store.

### 5.7 Vault

The resilience subsystem stores resilience state in Vault. It does not create
new durable stores.

---

## 6. Boundaries

### 6.1 What the resilience subsystem owns

- Crash recovery
- Data failure recovery
- Provider failure recovery
- Backup restore
- Degraded-mode honesty
- Repair workflows
- Resilience state machine
- Resilience state projection

### 6.2 What the resilience subsystem does NOT own

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)
- Real-money actions (not owned by anyone — forbidden)
- Trusted runtime code (not self-modifiable)

---

## 7. Failure modes

| Failure | Handling |
|---|---|
| Process crash | Rebuild from journal, reconcile, resume |
| Data corruption | Quarantine, replay trusted prefix, degraded mode |
| Provider failure | Fallback to approved provider, retry with backup |
| Backup corruption | Refuse restore, report degraded |
| Repair failure | Report failed, request owner intervention |
| STOP ALL activated | Immediate halt |
| Journal corrupt | Deny everything, degraded mode |
| Self-modification attempt | Refused, journaled |
| Authority widening attempt | Refused, journaled |

---

## 8. Resilience invariants

These invariants must hold at all times:

1. **No continuous reasoning** — Recovery is pursued through discrete wakes.
2. **No hidden spend** — No model call without a wake.
3. **No authority widening** — Every action flows through existing authority.
4. **No real-money actions** — No economic actions are performed.
5. **Deterministic** — Same state + same clock = same result.
6. **Event-sourced** — All state is derived from the journal.
7. **Explainable** — Every decision carries reasoning.
8. **Bounded** — Every recovery has a deadline and completion criteria.
9. **Auditable** — Every recovery is journaled.
10. **No self-modification** — Trusted runtime code is never self-modified.
11. **Degraded mode is truthful** — Degradation is never hidden.
12. **Repairs are authorized** — No unauthorized repair is performed.
