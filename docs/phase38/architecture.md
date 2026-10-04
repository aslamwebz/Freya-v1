# Phase 38 — Architecture Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Cognitive Evolution is the subsystem that enables Freya to improve her
planning, reasoning, and learning based on verified evidence, without authority
drift. It extends the existing Experience → Knowledge → Skill architecture
(Phase 28) and Self-Improving Architecture (Phase 30) to provide evidence-driven
improvement.

The core invariant:

> **Cognitive evolution is evidence-driven improvement without authority drift.
> Every improvement is authorized, auditable, and reversible. No hidden
> self-modification, no authority widening, no autonomous real-money actions.**

Every decision flows through existing authority paths (Guard, Governor,
STOP ALL, approvals, budgets). No new authority is created. No real-money
action is performed. No trusted runtime code is self-modified.

---

## 2. Design principles

### 2.1 Evidence-driven

Every improvement is based on verified evidence. No improvement is made without
evidence. No evidence is fabricated.

### 2.2 Authority-preserving

The evolution subsystem cannot:
- Create grants
- Widen budgets
- Bypass Guard
- Override Governor
- Clear STOP ALL
- Approve its own requests
- Perform real-money actions
- Self-modify trusted runtime code

### 2.3 No authority drift

Authority drift is explicitly detected and prevented. The evolution subsystem
never widens its own authority. It never modifies its own boundaries.

### 2.4 Deterministic before cognitive

Every decision before a model call is deterministic: same state + same clock
= same result. This is testable, auditable, and safe.

### 2.5 Explainable

Every evolution decision carries:
- What was decided
- Why it was decided
- What alternatives were considered
- What is uncertain
- What is blocked

### 2.6 Zero hidden spend

No model call without a wake. No continuous polling. No hidden reasoning.
No background processing. No self-scheduling timers.

### 2.7 Auditable

Every improvement, evidence verification, and drift check is journaled.

---

## 3. Components

### 3.1 EvidenceDrivenImprovement (new, Phase 38)

Evidence-driven improvement based on verified evidence.

**Responsibilities:**
- Verify evidence for improvement
- Track improvement metrics
- Journal all improvement decisions

**Does NOT:**
- Call a model for deterministic evidence verification
- Create authority
- Bypass Guard
- Self-modify trusted runtime code

### 3.2 PlanningReasoningLearning (new, Phase 38)

Evidence-driven improvement of planning, reasoning, and learning.

**Responsibilities:**
- Improve planning based on evidence
- Improve reasoning based on evidence
- Improve learning based on evidence
- Journal all improvements

**Does NOT:**
- Call a model for deterministic improvement
- Create authority
- Bypass Guard
- Self-modify trusted runtime code

### 3.3 AuthorityDriftPrevention (new, Phase 38)

Explicit prevention of authority drift.

**Responsibilities:**
- Detect authority drift attempts
- Enforce authority boundaries
- Prevent self-modification
- Journal all drift checks

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Self-modify trusted runtime code

### 3.4 EvolutionStateMachine (new, Phase 38)

Manages the evolution state transitions.

**States:**
- `STABLE` — Normal operation
- `EVALUATING` — Evidence is being evaluated
- `IMPROVING` — Improvement is being applied
- `VERIFYING` — Improvement is being verified
- `STAGING` — Improvement is in staging
- `FAILED` — Improvement failed (terminal)

### 3.5 EvolutionState (new, Phase 38)

The explainable evolution state. Answers:
- What is being improved now
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
EvolutionStateMachine.evaluate(state)
    │
    ├─ stable → STABLE
    ├─ evaluating → EVALUATING
    ├─ improving → IMPROVING
    ├─ verifying → VERIFYING
    ├─ staging → STAGING
    ├─ failed → FAILED (terminal)
    │
    ▼
EvidenceDrivenImprovement.verify(evidence)
    │
    ├─ insufficient → STABLE (wait for more evidence)
    │
    ▼ sufficient
AuthorityDriftPrevention.check(improvement)
    │
    ├─ drift detected → DENY (journaled)
    │
    ▼ no drift
Governor.evaluate(request)
    │
    ├─ deny → DENY (journaled)
    │
    ▼ allow
PlanningReasoningLearning.apply(improvement)
    │
    ▼
Verification
    │
    ├─ passed → STAGING (ready for review)
    ├─ failed → FAILED (or retry)
    │
    ▼
Continuation decision
    │
    ├─ continue → STABLE (improvement applied)
    ├─ stage → STAGING (awaiting review)
    ├─ retry → EVALUATING (retry with more evidence)
    ├─ fail → FAILED (terminal)
```

---

## 5. Integration with existing subsystems

### 5.1 Phase 28 — Experience → Knowledge → Skill

The evolution subsystem uses Phase 28's experience, knowledge, and skill
architecture. It extends it with evidence-driven improvement.

### 5.2 Phase 30 — Self-Improving Architecture

The evolution subsystem uses Phase 30's staging-branch improvement loop. It
extends it with authority drift prevention.

### 5.3 Guard

The evolution subsystem checks capabilities through `Guard.evaluate()`. It
does not bypass Guard.

### 5.4 Governor

The evolution subsystem requests cognition through `Governor.evaluate()`.
It does not bypass Governor.

### 5.5 EventStore

The evolution subsystem appends events through `EventFabric.append()`. It
does not create a parallel store.

### 5.6 Vault

The evolution subsystem stores evolution state in Vault. It does not create
new durable stores.

---

## 6. Boundaries

### 6.1 What the evolution subsystem owns

- Evidence-driven improvement
- Planning/reasoning/learning improvement
- Authority drift prevention
- Evolution state machine
- Evolution state projection

### 6.2 What the evolution subsystem does NOT own

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
| Insufficient evidence | Wait for more evidence |
| Authority drift detected | Deny, journaled |
| Governor denies | Deny, journaled |
| Improvement fails | Retry or fail |
| Verification fails | Retry or fail |
| STOP ALL activated | Immediate halt |
| Self-modification attempt | Refused, journaled |

---

## 8. Evolution invariants

These invariants must hold at all times:

1. **No continuous reasoning** — Evolution is pursued through discrete wakes.
2. **No hidden spend** — No model call without a wake.
3. **No authority widening** — Every action flows through existing authority.
4. **No real-money actions** — No economic actions are performed.
5. **Deterministic** — Same state + same clock = same result.
6. **Event-sourced** — All state is derived from the journal.
7. **Explainable** — Every decision carries reasoning.
8. **Bounded** — Every improvement has a deadline and completion criteria.
9. **Evidence-driven** — Every improvement is based on verified evidence.
10. **No authority drift** — Authority drift is explicitly prevented.
11. **No self-modification** — Trusted runtime code is never self-modified.
12. **Auditable** — Every improvement is journaled.
