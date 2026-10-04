# Phase 39 — Architecture Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

The Mature Freya Threshold is the culmination gate of Freya Lane 3. It proves
that the capabilities built across Phases 30–38 are coherent, bounded,
verifiable, and owner-controlled — without widening authority.

The core invariant:

> **Phase 39 is a threshold to prove — not a license to widen authority.
> Maturity is measured across 14 dimensions with verifiable evidence. Every
> criterion is testable, auditable, and fail-closed. No authority widening, no
> hidden inference, no real-money autonomy, no self-modification of trusted
> runtime code.**

Every decision flows through existing authority paths (Guard, Governor,
STOP ALL, approvals, budgets). No new authority is created. No real-money
action is performed. No trusted runtime code is self-modified. No maturity is
self-granted.

---

## 2. Design principles

### 2.1 Threshold to prove, not license to widen

Phase 39 proves maturity. It does not grant authority. Proving maturity does
not expand capabilities, spending, or autonomy. Authority boundaries remain
exactly as established by Guard, Governor, STOP ALL, approvals and budgets.

### 2.2 Measurable, not declared

Every maturity criterion is measurable and testable. Maturity is never
declared without evidence. Self-assessment without evidence is not maturity.

### 2.3 Evidence-driven

Every maturity claim is based on verified evidence. No claim is made without
evidence. No evidence is fabricated.

### 2.4 Fail-closed

Any ambiguity, uncertainty, or boundary violation results in refusal, halt,
or denial — never in assumed maturity. The system fails closed, not open.

### 2.5 Authority-preserving

The threshold subsystem cannot:
- Create grants
- Widen budgets
- Bypass Guard
- Override Governor
- Clear STOP ALL
- Approve its own requests
- Perform real-money actions
- Self-modify trusted runtime code
- Grant itself maturity

### 2.6 Deterministic before cognitive

Every decision before a model call is deterministic: same state + same clock
= same result. This is testable, auditable, and safe.

### 2.7 Explainable

Every threshold decision carries:
- What was decided
- Why it was decided
- What evidence supports it
- What alternatives were considered
- What is uncertain
- What is blocked

### 2.8 Zero hidden spend

No model call without a wake. No continuous polling. No hidden reasoning.
No background processing. No self-scheduling timers.

### 2.9 Auditable

Every assessment, evidence verification, threshold decision, fail-closed
decision, and rollback is journaled.

### 2.10 Owner-controlled

The owner may revoke, suspend, or re-assess maturity at any time. Freya
cannot self-grant or self-revoke maturity.

---

## 3. Components

### 3.1 MaturityAssessor (new, Phase 39)

Assesses maturity across 14 dimensions using measurable criteria.

**Responsibilities:**
- Assess each dimension against its measurable criteria
- Collect and verify evidence for each criterion
- Produce a maturity assessment with explicit evidence references
- Never self-grant maturity without evidence

**Does NOT:**
- Call a model for deterministic assessment
- Create authority
- Bypass Guard
- Self-modify trusted runtime code
- Widen its own authority

### 3.2 ThresholdGate (new, Phase 39)

The gate that proves or does not prove maturity.

**Responsibilities:**
- Evaluate the maturity assessment against the acceptance matrix
- Produce a threshold decision: `proven` or `not-proven`
- Journal the threshold decision with evidence
- Never produce `proven` without all criteria passing

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Self-modify trusted runtime code
- Widen its own authority

### 3.3 FailClosedEnforcer (new, Phase 39)

Enforces fail-closed conditions.

**Responsibilities:**
- Refuse on ambiguity
- Halt on uncertainty
- Deny on boundary violation
- Journal all fail-closed decisions

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Self-modify trusted runtime code
- Widen its own authority

### 3.4 EvidenceCollector (new, Phase 39)

Collects, verifies, and journals evidence.

**Responsibilities:**
- Collect evidence from verified sources
- Verify evidence quality and provenance
- Journal all evidence
- Never fabricate evidence

**Does NOT:**
- Call a model for deterministic evidence verification
- Create authority
- Bypass Guard
- Self-modify trusted runtime code
- Widen its own authority

### 3.5 RollbackController (new, Phase 39)

Controls rollback of the threshold.

**Responsibilities:**
- Detect rollback conditions
- Execute owner-controlled rollback
- Journal all rollback decisions
- Never rollback without owner approval

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Self-modify trusted runtime code
- Widen its own authority

### 3.6 ThresholdStateMachine (new, Phase 39)

Manages the threshold state transitions.

**States:**
- `UNPROVEN` — Maturity not yet proven
- `ASSESSING` — Maturity is being assessed
- `EVIDENCING` — Evidence is being collected
- `EVALUATING` — Evidence is being evaluated
- `PROVEN` — Maturity is proven
- `SUSPENDED` — Maturity is suspended (fail-closed or owner action)
- `ROLLED_BACK` — Maturity is rolled back (terminal)

### 3.7 ThresholdState (new, Phase 39)

The explainable threshold state. Answers:
- What is being assessed now
- Why it matters
- What evidence supports it
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
ThresholdStateMachine.evaluate(state)
    │
    ├─ unproven → UNPROVEN
    ├─ assessing → ASSESSING
    ├─ evidencing → EVIDENCING
    ├─ evaluating → EVALUATING
    ├─ proven → PROVEN
    ├─ suspended → SUSPENDED
    ├─ rolled-back → ROLLED_BACK (terminal)
    │
    ▼
MaturityAssessor.assess(dimensions)
    │
    ├─ insufficient evidence → UNPROVEN (wait for more evidence)
    │
    ▼ sufficient
EvidenceCollector.verify(evidence)
    │
    ├─ insufficient → UNPROVEN (wait for more evidence)
    │
    ▼ sufficient
FailClosedEnforcer.check(conditions)
    │
    ├─ fail-closed triggered → SUSPENDED (journaled)
    │
    ▼ no fail-closed
ThresholdGate.evaluate(assessment)
    │
    ├─ all criteria pass → PROVEN (journaled)
    ├─ any criterion fails → UNPROVEN (journaled)
    │
    ▼
Verification
    │
    ├─ passed → PROVEN (threshold proven)
    ├─ failed → UNPROVEN (threshold not proven)
    │
    ▼
Continuation decision
    │
    ├─ continue → PROVEN (maturity maintained)
    ├─ suspend → SUSPENDED (fail-closed or owner action)
    ├─ rollback → ROLLED_BACK (owner-controlled, terminal)
    ├─ re-assess → ASSESSING (new assessment)
    ├─ stop → UNPROVEN (threshold not proven)
```

---

## 5. Integration with existing subsystems

### 5.1 Phase 31 — Long-Horizon Autonomy

The threshold uses Phase 31's long-horizon autonomy to prove long-horizon
behavior maturity. It does not write to Phase 31.

### 5.2 Phase 32 — Economic Intelligence

The threshold uses Phase 32's economic intelligence to prove economic
boundaries maturity. It does not write to Phase 32.

### 5.3 Phase 33 — Autonomous Enterprise

The threshold uses Phase 33's autonomous enterprise to prove enterprise
boundaries maturity. It does not write to Phase 33.

### 5.4 Phase 36 — Resilience & Self-Recovery

The threshold uses Phase 36's resilience to prove resilience and recovery
maturity. It does not write to Phase 36.

### 5.5 Phase 37 — Sovereign Intelligence

The threshold uses Phase 37's sovereign intelligence to prove security and
privacy maturity. It does not write to Phase 37.

### 5.6 Phase 38 — Cognitive Evolution

The threshold uses Phase 38's cognitive evolution to prove self-improvement
maturity. It does not write to Phase 38.

### 5.7 Guard

The threshold checks capabilities through `Guard.evaluate()`. It does not
bypass Guard.

### 5.8 Governor

The threshold requests cognition through `Governor.evaluate()`. It does not
bypass Governor.

### 5.9 EventStore

The threshold appends events through `EventFabric.append()`. It does not
create a parallel store.

### 5.10 Vault

The threshold stores threshold state in Vault. It does not create new
durable stores.

---

## 6. Boundaries

### 6.1 What the threshold subsystem owns

- Maturity assessment across 14 dimensions
- Threshold gate decisions
- Fail-closed enforcement
- Evidence collection and verification
- Rollback control
- Threshold state machine
- Threshold state projection

### 6.2 What the threshold subsystem does NOT own

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)
- Real-money actions (not owned by anyone — forbidden)
- Trusted runtime code (not self-modifiable)
- Maturity grants (not self-grantable)

---

## 7. Failure modes

| Failure | Handling |
|---|---|
| Insufficient evidence | Wait for more evidence |
| Evidence fabrication detected | Refuse, journaled, SUSPENDED |
| Fail-closed condition triggered | Halt, journaled, SUSPENDED |
| Governor denies | Deny, journaled |
| Assessment fails | Re-assess or UNPROVEN |
| Verification fails | Re-assess or UNPROVEN |
| STOP ALL activated | Immediate halt |
| Self-modification attempt | Refused, journaled |
| Maturity forgery attempt | Refused, journaled, SUSPENDED |
| Rollback condition detected | Owner-controlled rollback |

---

## 8. Threshold invariants

These invariants must hold at all times:

1. **No continuous reasoning** — Threshold assessment is pursued through discrete wakes.
2. **No hidden spend** — No model call without a wake.
3. **No authority widening** — Every action flows through existing authority.
4. **No real-money actions** — No economic actions are performed.
5. **Deterministic** — Same state + same clock = same result.
6. **Event-sourced** — All state is derived from the journal.
7. **Explainable** — Every decision carries reasoning.
8. **Bounded** — Every assessment has a deadline and completion criteria.
9. **Evidence-driven** — Every maturity claim is based on verified evidence.
10. **No authority drift** — Authority drift is explicitly prevented.
11. **No self-modification** — Trusted runtime code is never self-modified.
12. **Auditable** — Every decision is journaled.
13. **Fail-closed** — Ambiguity, uncertainty, and boundary violations result in refusal.
14. **Owner-controlled** — The owner controls maturity revocation and rollback.
15. **No self-granted maturity** — Maturity is never self-granted.
16. **No maturity-as-license** — Maturity does not widen authority.
