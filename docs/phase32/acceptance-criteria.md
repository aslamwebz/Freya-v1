# Phase 32 — Acceptance Criteria

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

These acceptance criteria define the conditions that must be met for Phase 32
to be considered complete. They are the gate between preparation and
implementation.

Each criterion is testable and auditable. A criterion is met when its test
passes and its invariant holds.

---

## 2. Functional criteria

### 2.1 Research engine

| Criterion | Test |
|---|---|
| F1: Research is bounded | `research.bounded` |
| F2: Evidence is sourced | `research.evidence-sourced` |
| F3: Evidence is cited | `research.evidence-cited` |
| F4: Evidence freshness is tracked | `research.evidence-freshness-tracked` |
| F5: Research is deterministic | `research.deterministic` |
| F6: Research never calls a model | `research.no-model-calls` |
| F7: Research performs no real-money actions | `research.no-real-money-actions` |

### 2.2 Simulation engine

| Criterion | Test |
|---|---|
| F8: Simulation is bounded | `simulation.bounded` |
| F9: Scenarios are deterministic | `simulation.scenarios-deterministic` |
| F10: Results carry assumptions | `simulation.results-carry-assumptions` |
| F11: Simulation is deterministic | `simulation.deterministic` |
| F12: Simulation never calls a model | `simulation.no-model-calls` |
| F13: Simulation performs no real-money actions | `simulation.no-real-money-actions` |

### 2.3 Paper trading engine

| Criterion | Test |
|---|---|
| F14: Paper orders are simulated | `paper-trading.orders-simulated` |
| F15: No real orders are placed | `paper-trading.no-real-orders` |
| F16: Paper portfolio is tracked | `paper-trading.portfolio-tracked` |
| F17: Metrics have denominators | `paper-trading.metrics-have-denominators` |
| F18: Metrics have units | `paper-trading.metrics-have-units` |
| F19: Paper trading is deterministic | `paper-trading.deterministic` |
| F20: Paper trading never calls a model | `paper-trading.no-model-calls` |
| F21: Paper trading performs no real-money actions | `paper-trading.no-real-money-actions` |

### 2.4 Economic state

| Criterion | Test |
|---|---|
| F22: Economic state is computed from durable state | `state.computed` |
| F23: Every item carries reasoning | `state.explainable` |
| F24: Uncertainty is never hidden | `state.honest-about-uncertainty` |
| F25: Confidence is never fabricated | `state.no-fabricated-confidence` |
| F26: Lists and strings are bounded | `state.bounded` |
| F27: Economic state is deterministic | `state.deterministic` |
| F28: Economic state never calls a model | `state.no-model-calls` |

---

## 3. Authority criteria

### 3.1 Guard

| Criterion | Test |
|---|---|
| A1: Guard capability checks are never bypassed | `authority.guard-not-bypassed` |
| A2: Experiments cannot be assigned capabilities they do not hold | `redteam.experiment-claims-capability` |

### 3.2 Governor

| Criterion | Test |
|---|---|
| A3: Governor cognition authorization is never bypassed | `authority.governor-not-bypassed` |
| A4: Experiments cannot request cognition without a grant | `redteam.experiment-claims-authority` |

### 3.3 STOP ALL

| Criterion | Test |
|---|---|
| A5: STOP ALL immediately halts everything | `authority.stop-all-respected` |
| A6: STOP ALL cannot be bypassed | `redteam.bypass-stop-all` |

### 3.4 Budgets

| Criterion | Test |
|---|---|
| A7: Budget limits are never exceeded | `authority.budgets-respected` |
| A8: Experiments cannot claim more budget | `redteam.experiment-claims-budget` |

### 3.5 Approvals

| Criterion | Test |
|---|---|
| A9: Approval requirements are never skipped | `authority.approvals-respected` |
| A10: Experiments cannot approve their own requests | `authority.no-self-approval` |
| A11: Experiments cannot claim approval | `redteam.experiment-claims-approval` |

### 3.6 Grants

| Criterion | Test |
|---|---|
| A12: Experiments cannot create grants | `authority.no-grant-creation` |
| A13: Only the owner may create grants | `redteam.create-grant` |

### 3.7 Capabilities

| Criterion | Test |
|---|---|
| A14: Capabilities are never widened beyond code-owned ceilings | `authority.no-capability-widening` |
| A15: Experiments cannot widen their own capabilities | `redteam.widen-capability` |

### 3.8 Real-money actions

| Criterion | Test |
|---|---|
| A16: No real-money/economic actions are performed | `authority.no-real-money-actions` |
| A17: No spending authority is added | `authority.no-spending-authority` |
| A18: No real orders are placed | `authority.no-real-orders` |

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
| RT1: Experiment claims capability → refused | `redteam.experiment-claims-capability` |
| RT2: Experiment claims authority → refused | `redteam.experiment-claims-authority` |
| RT3: Experiment claims to be owner → refused | `redteam.experiment-claims-owner` |
| RT4: Experiment claims higher priority → refused | `redteam.experiment-claims-priority` |
| RT5: Experiment claims more budget → refused | `redteam.experiment-claims-budget` |
| RT6: Experiment claims approval → refused | `redteam.experiment-claims-approval` |
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
| RT24: Real order attempted → refused | `redteam.real-order-attempted` |

---

## 6. Integration criteria

| Criterion | Test |
|---|---|
| I1: Wake → filter → research → simulate → paper-trade → state | `integration.wake-to-decision` |
| I2: Wake → filter → research → simulate → paper-trade → verify → continue | `integration.wake-to-verification` |
| I3: Wake → ... → escalate → owner notified | `integration.wake-to-escalation` |
| I4: Wake → ... → STOP ALL → halt | `integration.wake-to-stop` |
| I5: Multi-day experiment continuation across wakes | `integration.multi-day-continuation` |
| I6: Experiment dependency resolution | `integration.experiment-dependency-resolution` |
| I7: Paper order verification flow | `integration.paper-order-verification` |
| I8: Interrupted experiment recovery | `integration.interrupted-experiment-recovery` |

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

Phase 32 is accepted when:

1. All functional criteria (F1–F28) pass
2. All authority criteria (A1–A18) pass
3. All zero-idle-inference criteria (Z1–Z9) pass
4. All red-team criteria (RT1–RT24) pass
5. All integration criteria (I1–I8) pass
6. All non-functional criteria pass
7. Full test suite passes
8. Typecheck passes
9. Lint passes
10. Red-team review passes
11. Owner approval
