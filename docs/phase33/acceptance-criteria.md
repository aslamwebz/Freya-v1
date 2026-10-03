# Phase 33 — Acceptance Criteria

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

These acceptance criteria define the conditions that must be met for Phase 33
to be considered complete. They are the gate between preparation and
implementation.

Each criterion is testable and auditable. A criterion is met when its test
passes and its invariant holds.

---

## 2. Functional criteria

### 2.1 Business environment

| Criterion | Test |
|---|---|
| F1: Environments are durable | `environment.survive-restart` |
| F2: Environments have explicit completion criteria | `environment.have-completion-criteria` |
| F3: Environments track progress | `environment.track-progress` |
| F4: Environments have enterprise boundaries | `environment.have-boundaries` |
| F5: Environments have spending limits | `environment.have-spending-limits` |
| F6: Environments are deterministic | `environment.deterministic` |
| F7: Environments never call a model | `environment.no-model-calls` |

### 2.2 Enterprise boundaries

| Criterion | Test |
|---|---|
| F8: Boundaries are enforced | `boundaries.enforced` |
| F9: Boundaries are deterministic | `boundaries.deterministic` |
| F10: Boundaries are journaled | `boundaries.journaled` |
| F11: Boundaries cannot be widened | `boundaries.cannot-be-widened` |
| F12: Boundary violations are refused | `boundaries.violations-refused` |

### 2.3 Task and mission orchestration

| Criterion | Test |
|---|---|
| F13: Tasks are bounded | `tasks.bounded` |
| F14: Missions are bounded | `missions.bounded` |
| F15: Tasks are deterministic | `tasks.deterministic` |
| F16: Missions are deterministic | `missions.deterministic` |
| F17: Tasks never call a model | `tasks.no-model-calls` |
| F18: Missions never call a model | `missions.no-model-calls` |

### 2.4 Webzone interfaces

| Criterion | Test |
|---|---|
| F19: Webzone operations are bounded | `webzone.bounded` |
| F20: Webzone operations are auditable | `webzone.auditable` |
| F21: Webzone operations are deterministic | `webzone.deterministic` |
| F22: Webzone operations never call a model | `webzone.no-model-calls` |
| F23: Webzone operations respect boundaries | `webzone.respects-boundaries` |

### 2.5 Auditability

| Criterion | Test |
|---|---|
| F24: Every decision is journaled | `audit.decisions-journaled` |
| F25: Every action is journaled | `audit.actions-journaled` |
| F26: Every refusal is journaled | `audit.refusals-journaled` |
| F27: Every boundary check is journaled | `audit.boundary-checks-journaled` |
| F28: Every spending gate check is journaled | `audit.spending-gate-checks-journaled` |
| F29: Every verification is journaled | `audit.verifications-journaled` |
| F30: Every rollback is journaled | `audit.rollbacks-journaled` |

### 2.6 Approvals

| Criterion | Test |
|---|---|
| F31: Approvals are explicit | `approvals.explicit` |
| F32: Approvals are durable | `approvals.durable` |
| F33: Approvals are auditable | `approvals.auditable` |
| F34: Approvals are enforced | `approvals.enforced` |
| F35: Approvals are never skipped | `approvals.never-skipped` |

### 2.7 Spending gates

| Criterion | Test |
|---|---|
| F36: Spending gates are enforced | `spending-gates.enforced` |
| F37: Spending gates are deterministic | `spending-gates.deterministic` |
| F38: Spending gates are journaled | `spending-gates.journaled` |
| F39: Spending gates cannot be widened | `spending-gates.cannot-be-widened` |
| F40: Spending gate violations are refused | `spending-gates.violations-refused` |

### 2.8 External-action verification

| Criterion | Test |
|---|---|
| F41: Every external action is verified | `verification.every-action-verified` |
| F42: Verification is bounded | `verification.bounded` |
| F43: Verification is deterministic | `verification.deterministic` |
| F44: Verification outcomes are journaled | `verification.outcomes-journaled` |
| F45: Verification never fabricates outcomes | `verification.never-fabricates` |

### 2.9 Rollback/recovery

| Criterion | Test |
|---|---|
| F46: Reversible actions can be rolled back | `rollback.reversible-actions-rolled-back` |
| F47: Irreversible actions cannot be rolled back | `rollback.irreversible-actions-refused` |
| F48: Rollback is bounded | `rollback.bounded` |
| F49: Rollback is deterministic | `rollback.deterministic` |
| F50: Rollback outcomes are journaled | `rollback.outcomes-journaled` |

### 2.10 Enterprise state

| Criterion | Test |
|---|---|
| F51: Enterprise state is computed from durable state | `state.computed` |
| F52: Enterprise state is explainable | `state.explainable` |
| F53: Enterprise state is honest about uncertainty | `state.honest-about-uncertainty` |
| F54: Enterprise state is bounded | `state.bounded` |
| F55: Enterprise state is deterministic | `state.deterministic` |
| F56: Enterprise state never calls a model | `state.no-model-calls` |

---

## 3. Authority criteria

### 3.1 Guard

| Criterion | Test |
|---|---|
| A1: Guard capability checks are never bypassed | `authority.guard-not-bypassed` |
| A2: Environments cannot be assigned capabilities they do not hold | `redteam.environment-claims-capability` |

### 3.2 Governor

| Criterion | Test |
|---|---|
| A3: Governor cognition authorization is never bypassed | `authority.governor-not-bypassed` |
| A4: Environments cannot request cognition without a grant | `redteam.environment-claims-authority` |

### 3.3 STOP ALL

| Criterion | Test |
|---|---|
| A5: STOP ALL immediately halts everything | `authority.stop-all-respected` |
| A6: STOP ALL cannot be bypassed | `redteam.bypass-stop-all` |

### 3.4 Budgets

| Criterion | Test |
|---|---|
| A7: Budget limits are never exceeded | `authority.budgets-respected` |
| A8: Environments cannot claim more budget | `redteam.environment-claims-budget` |

### 3.5 Approvals

| Criterion | Test |
|---|---|
| A9: Approval requirements are never skipped | `authority.approvals-respected` |
| A10: Environments cannot approve their own requests | `authority.no-self-approval` |
| A11: Environments cannot claim approval | `redteam.environment-claims-approval` |

### 3.6 Grants

| Criterion | Test |
|---|---|
| A12: Environments cannot create grants | `authority.no-grant-creation` |
| A13: Only the owner may create grants | `redteam.create-grant` |

### 3.7 Capabilities

| Criterion | Test |
|---|---|
| A14: Capabilities are never widened beyond code-owned ceilings | `authority.no-capability-widening` |
| A15: Environments cannot widen their own capabilities | `redteam.widen-capability` |

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
| RT1: Environment claims capability → refused | `redteam.environment-claims-capability` |
| RT2: Environment claims authority → refused | `redteam.environment-claims-authority` |
| RT3: Environment claims to be owner → refused | `redteam.environment-claims-owner` |
| RT4: Environment claims higher priority → refused | `redteam.environment-claims-priority` |
| RT5: Environment claims more budget → refused | `redteam.environment-claims-budget` |
| RT6: Environment claims approval → refused | `redteam.environment-claims-approval` |
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
| RT25: Exceed spending gate → refused | `redteam.exceed-spending-gate` |
| RT26: Cross enterprise boundary → refused | `redteam.cross-enterprise-boundary` |
| RT27: Rollback irreversible action → refused | `redteam.rollback-irreversible` |
| RT28: Fabricate verification outcome → refused | `redteam.fabricate-verification` |

---

## 6. Integration criteria

| Criterion | Test |
|---|---|
| I1: Wake → filter → environment → orchestrate → webzone → state | `integration.wake-to-decision` |
| I2: Wake → filter → environment → orchestrate → webzone → verify → continue | `integration.wake-to-verification` |
| I3: Wake → ... → escalate → owner notified | `integration.wake-to-escalation` |
| I4: Wake → ... → STOP ALL → halt | `integration.wake-to-stop` |
| I5: Multi-day environment continuation across wakes | `integration.multi-day-continuation` |
| I6: Environment dependency resolution | `integration.environment-dependency-resolution` |
| I7: Webzone operation verification flow | `integration.webzone-verification` |
| I8: Interrupted environment recovery | `integration.interrupted-environment-recovery` |
| I9: Rollback flow | `integration.rollback-flow` |
| I10: Spending gate enforcement flow | `integration.spending-gate-flow` |

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
- Every boundary check is journaled
- Every spending gate check is journaled
- Every verification is journaled
- Every rollback is journaled

---

## 8. Acceptance gate

Phase 33 is accepted when:

1. All functional criteria (F1–F56) pass
2. All authority criteria (A1–A18) pass
3. All zero-idle-inference criteria (Z1–Z9) pass
4. All red-team criteria (RT1–RT28) pass
5. All integration criteria (I1–I10) pass
6. All non-functional criteria pass
7. Full test suite passes
8. Typecheck passes
9. Lint passes
10. Red-team review passes
11. Owner approval
