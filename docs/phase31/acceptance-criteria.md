# Phase 31 — Acceptance Criteria

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

These acceptance criteria define the conditions that must be met for Phase 31
to be considered complete. They are the gate between preparation and
implementation.

Each criterion is testable and auditable. A criterion is met when its test
passes and its invariant holds.

---

## 2. Functional criteria

### 2.1 Persistent goals

| Criterion | Test |
|---|---|
| F1: Goals are durable | `goals.survive-restart` |
| F2: Goals have explicit completion criteria | `goals.have-completion-criteria` |
| F3: Goals track progress | `goals.track-progress` |
| F4: Goals have dependencies | `goals.have-dependencies` |
| F5: Goals are deterministic | `goals.deterministic` |
| F6: Goals never call a model | `goals.no-model-calls` |

### 2.2 Bounded scheduling

| Criterion | Test |
|---|---|
| F7: Schedules are host-driven | `scheduler.host-driven` |
| F8: Schedules are deterministic | `scheduler.deterministic` |
| F9: Schedules enforce limits | `scheduler.enforces-limits` |
| F10: Schedules never call a model | `scheduler.no-model-calls` |
| F11: Schedules are idempotent | `scheduler.idempotent` |

### 2.3 Long-horizon continuation

| Criterion | Test |
|---|---|
| F12: Continuation is event-driven | `continuation.event-driven` |
| F13: Continuation is bounded | `continuation.bounded` |
| F14: Continuation is deterministic | `continuation.deterministic` |
| F15: Continuation never calls a model | `continuation.no-model-calls` |

### 2.4 Verification

| Criterion | Test |
|---|---|
| F16: Every checkpoint is verified | `verification.every-checkpoint-verified` |
| F17: Verification is bounded | `verification.bounded` |
| F18: Verification is deterministic | `verification.deterministic` |
| F19: Retry ceilings are enforced | `verification.retry-ceiling` |
| F20: Backoff is bounded | `verification.backoff-bounded` |

### 2.5 Restart continuity

| Criterion | Test |
|---|---|
| F21: Goals survive restarts | `restart.goals-survive` |
| F22: Checkpoints survive restarts | `restart.checkpoints-survive` |
| F23: Schedules survive restarts | `restart.schedules-survive` |
| F24: Grants survive restarts | `restart.grants-survive` |
| F25: STOP ALL survives restarts | `restart.stop-all-survives` |
| F26: No silent continuation | `restart.no-silent-continuation` |
| F27: No fabricated state | `restart.no-fabricated-state` |

### 2.6 Uncertainty handling

| Criterion | Test |
|---|---|
| F28: Assumptions are explicit | `uncertainty.assumptions-explicit` |
| F29: Assumptions have expiration | `uncertainty.assumptions-have-expiration` |
| F30: Stale evidence is detected | `uncertainty.stale-evidence-detected` |
| F31: Conflicted evidence is preserved | `uncertainty.conflicted-evidence-preserved` |
| F32: Confidence is never fabricated | `uncertainty.confidence-not-fabricated` |

### 2.7 Long-horizon state

| Criterion | Test |
|---|---|
| F33: Long-horizon state is computed from durable state | `state.computed` |
| F34: Long-horizon state is explainable | `state.explainable` |
| F35: Long-horizon state is honest about uncertainty | `state.honest-about-uncertainty` |
| F36: Long-horizon state is bounded | `state.bounded` |
| F37: Long-horizon state is deterministic | `state.deterministic` |
| F38: Long-horizon state never calls a model | `state.no-model-calls` |

---

## 3. Authority criteria

### 3.1 Guard

| Criterion | Test |
|---|---|
| A1: Guard capability checks are never bypassed | `authority.guard-not-bypassed` |
| A2: Goals cannot be assigned capabilities they do not hold | `redteam.goal-claims-capability` |

### 3.2 Governor

| Criterion | Test |
|---|---|
| A3: Governor cognition authorization is never bypassed | `authority.governor-not-bypassed` |
| A4: Goals cannot request cognition without a grant | `redteam.goal-claims-authority` |

### 3.3 STOP ALL

| Criterion | Test |
|---|---|
| A5: STOP ALL immediately halts everything | `authority.stop-all-respected` |
| A6: STOP ALL cannot be bypassed | `redteam.bypass-stop-all` |

### 3.4 Budgets

| Criterion | Test |
|---|---|
| A7: Budget limits are never exceeded | `authority.budgets-respected` |
| A8: Goals cannot claim more budget | `redteam.goal-claims-budget` |

### 3.5 Approvals

| Criterion | Test |
|---|---|
| A9: Approval requirements are never skipped | `authority.approvals-respected` |
| A10: Goals cannot approve their own requests | `authority.no-self-approval` |
| A11: Goals cannot claim approval | `redteam.goal-claims-approval` |

### 3.6 Grants

| Criterion | Test |
|---|---|
| A12: Goals cannot create grants | `authority.no-grant-creation` |
| A13: Only the owner may create grants | `redteam.create-grant` |

### 3.7 Capabilities

| Criterion | Test |
|---|---|
| A14: Capabilities are never widened beyond code-owned ceilings | `authority.no-capability-widening` |
| A15: Goals cannot widen their own capabilities | `redteam.widen-capability` |

### 3.8 Real-money actions

| Criterion | Test |
|---|---|
| A16: No real-money/economic actions are performed | `authority.no-real-money-actions` |
| A17: No spending authority is added | `authority.no-spending-authority` |

---

## 4. Zero-idle-inference criteria

| Criterion | Test |
|---|---|
| Z1: No model call without a wake | `zero-idle.no-model-call-without-wake` |
| Z2: No continuous polling | `zero-idle.no-continuous-polling` |
| Z3: No hidden reasoning | `zero-idle.no-hidden-reasoning` |
| Z4: No unrestricted loops | `zero-idle.no-unrestricted-loops` |
| Z5: No idle model call | `zero-idle.no-idle-model-call` |
| Z6: No background reasoning | `zero-idle.no-background-reasoning` |
| Z7: No hidden durable state | `zero-idle.no-hidden-durable-state` |
| Z8: Only authorized wake sources are accepted | `zero-idle.authorized-wake-sources` |
| Z9: Unauthorized wake sources are refused | `zero-idle.unauthorized-wake-refused` |

---

## 5. Red-team criteria

| Criterion | Test |
|---|---|
| RT1: Goal claims capability → refused | `redteam.goal-claims-capability` |
| RT2: Goal claims authority → refused | `redteam.goal-claims-authority` |
| RT3: Goal claims to be owner → refused | `redteam.goal-claims-owner` |
| RT4: Goal claims higher priority → refused | `redteam.goal-claims-priority` |
| RT5: Goal claims more budget → refused | `redteam.goal-claims-budget` |
| RT6: Goal claims approval → refused | `redteam.goal-claims-approval` |
| RT7: Bypass Guard → refused | `redteam.bypass-guard` |
| RT8: Bypass Governor → refused | `redteam.bypass-governor` |
| RT9: Bypass STOP ALL → refused | `redteam.bypass-stop-all` |
| RT10: Exceed budget → refused | `redteam.exceed-budget` |
| RT11: Skip approval → refused | `redteam.skip-approval` |
| RT12: Widen capability → refused | `redteam.widen-capability` |
| RT13: Create grant → refused | `redteam.create-grant` |
| RT14: Self-approve → refused | `redteam.self-approve` |
| RT15: Hidden inference → detected | `redteam.hidden-inference` |
| RT16: Continuous polling → detected | `redteam.continuous-polling` |
| RT17: Model output claims urgency → data | `redteam.model-claims-urgency` |
| RT18: Model output claims priority → data | `redteam.model-claims-priority` |
| RT19: Model output claims outcome → data | `redteam.model-claims-outcome` |
| RT20: Event claims importance → data | `redteam.event-claims-importance` |
| RT21: Event claims deadline → data | `redteam.event-claims-deadline` |
| RT22: Context claims authority → data | `redteam.context-claims-authority` |
| RT23: Real-money action attempted → refused | `redteam.real-money-action` |

---

## 6. Integration criteria

| Criterion | Test |
|---|---|
| I1: Wake → filter → schedule → continue → state | `integration.wake-to-decision` |
| I2: Wake → filter → schedule → continue → delegate → execute | `integration.wake-to-action` |
| I3: Wake → ... → execute → verify → continue | `integration.wake-to-verification` |
| I4: Wake → ... → escalate → owner notified | `integration.wake-to-escalation` |
| I5: Wake → ... → STOP ALL → halt | `integration.wake-to-stop` |
| I6: Multi-day goal continuation across wakes | `integration.multi-day-continuation` |
| I7: Multi-week goal continuation across wakes | `integration.multi-week-continuation` |
| I8: Goal dependency resolution | `integration.goal-dependency-resolution` |
| I9: Checkpoint verification flow | `integration.checkpoint-verification` |
| I10: Interrupted goal recovery | `integration.interrupted-goal-recovery` |

---

## 7. Non-functional criteria

### 7.1 Determinism

- Same inputs + same clock = same output
- No randomness in any decision
- No wall-clock reads in any decision
- No external service calls in any decision

### 7.2 Boundedness

- Every list has a maximum length
- Every string has a maximum length
- Every number is in a closed range
- Every loop has a maximum iteration count
- Every timer has a maximum duration

### 7.3 Explainability

- Every decision carries reasoning
- Every refusal carries a closed reason code
- Every assumption is explicit
- Every uncertainty is surfaced
- Every blocked item carries a blocked reason

### 7.4 Auditability

- Every decision is journaled
- Every refusal is journaled
- Every assumption is journaled
- Every escalation is journaled
- Every red-team attempt is journaled

---

## 8. Acceptance gate

Phase 31 is accepted when:

1. All functional criteria (F1–F38) pass
2. All authority criteria (A1–A17) pass
3. All zero-idle-inference criteria (Z1–Z9) pass
4. All red-team criteria (RT1–RT23) pass
5. All integration criteria (I1–I10) pass
6. All non-functional criteria pass
7. Full test suite passes
8. Typecheck passes
9. Lint passes
10. Red-team review passes
11. Owner approval
