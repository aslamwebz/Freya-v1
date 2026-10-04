# Phase 37 — Acceptance Criteria

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

These acceptance criteria define the conditions that must be met for Phase 37
to be considered complete. They are the gate between preparation and
implementation.

Each criterion is testable and auditable. A criterion is met when its test
passes and its invariant holds.

---

## 2. Functional criteria

### 2.1 Provider independence

| Criterion | Test |
|---|---|
| F1: Provider routing is bounded | `provider-routing.bounded` |
| F2: Provider routing is deterministic | `provider-routing.deterministic` |
| F3: Provider routing is journaled | `provider-routing.journaled` |
| F4: Provider fallback works | `provider-routing.fallback` |
| F5: Provider health tracking works | `provider-routing.health-tracking` |
| F6: Provider independence never adds providers | `provider-routing.never-adds-providers` |
| F7: Provider independence never calls a model | `provider-routing.no-model-calls` |

### 2.2 Offline/local reasoning

| Criterion | Test |
|---|---|
| F8: Offline reasoning is bounded | `offline-reasoning.bounded` |
| F9: Offline reasoning is deterministic | `offline-reasoning.deterministic` |
| F10: Offline reasoning is journaled | `offline-reasoning.journaled` |
| F11: Offline reasoning respects authority | `offline-reasoning.respects-authority` |
| F12: Offline reasoning never self-modifies | `offline-reasoning.never-self-modifies` |
| F13: Offline reasoning never calls a model | `offline-reasoning.no-model-calls` |

### 2.3 Portable encrypted data

| Criterion | Test |
|---|---|
| F14: Portable data is encrypted | `portable-data.encrypted` |
| F15: Portable data is bounded | `portable-data.bounded` |
| F16: Portable data is deterministic | `portable-data.deterministic` |
| F17: Portable data is journaled | `portable-data.journaled` |
| F18: Portable data never stores plaintext | `portable-data.never-stores-plaintext` |
| F19: Portable data is verified | `portable-data.verified` |
| F20: Portable data never self-modifies | `portable-data.never-self-modifies` |

### 2.4 Sovereignty state

| Criterion | Test |
|---|---|
| F21: Sovereignty state is computed from durable state | `state.computed` |
| F22: Sovereignty state is explainable | `state.explainable` |
| F23: Sovereignty state is honest about uncertainty | `state.honest-about-uncertainty` |
| F24: Sovereignty state is bounded | `state.bounded` |
| F25: Sovereignty state is deterministic | `state.deterministic` |
| F26: Sovereignty state never calls a model | `state.no-model-calls` |

---

## 3. Authority criteria

### 3.1 Guard

| Criterion | Test |
|---|---|
| A1: Guard capability checks are never bypassed | `authority.guard-not-bypassed` |
| A2: Sovereignty cannot be assigned capabilities it does not hold | `redteam.sovereignty-claims-capability` |

### 3.2 Governor

| Criterion | Test |
|---|---|
| A3: Governor cognition authorization is never bypassed | `authority.governor-not-bypassed` |
| A4: Sovereignty cannot request cognition without a grant | `redteam.sovereignty-claims-authority` |

### 3.3 STOP ALL

| Criterion | Test |
|---|---|
| A5: STOP ALL immediately halts everything | `authority.stop-all-respected` |
| A6: STOP ALL cannot be bypassed | `redteam.bypass-stop-all` |

### 3.4 Budgets

| Criterion | Test |
|---|---|
| A7: Budget limits are never exceeded | `authority.budgets-respected` |
| A8: Sovereignty cannot claim more budget | `redteam.sovereignty-claims-budget` |

### 3.5 Approvals

| Criterion | Test |
|---|---|
| A9: Approval requirements are never skipped | `authority.approvals-respected` |
| A10: Sovereignty cannot approve its own requests | `authority.no-self-approval` |
| A11: Sovereignty cannot claim approval | `redteam.sovereignty-claims-approval` |

### 3.6 Grants

| Criterion | Test |
|---|---|
| A12: Sovereignty cannot create grants | `authority.no-grant-creation` |
| A13: Only the owner may create grants | `redteam.create-grant` |

### 3.7 Capabilities

| Criterion | Test |
|---|---|
| A14: Capabilities are never widened beyond code-owned ceilings | `authority.no-capability-widening` |
| A15: Sovereignty cannot widen its own capabilities | `redteam.widen-capability` |

### 3.8 Real-money actions

| Criterion | Test |
|---|---|
| A16: No real-money/economic actions are performed | `authority.no-real-money-actions` |
| A17: No spending authority is added | `authority.no-spending-authority` |
| A18: No real orders are placed | `authority.no-real-orders` |

### 3.9 Self-modification

| Criterion | Test |
|---|---|
| A19: No trusted runtime code is self-modified | `authority.no-self-modification` |
| A20: Self-modification attempts are refused | `redteam.self-modification` |

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
| RT1: Sovereignty claims capability → refused | `redteam.sovereignty-claims-capability` |
| RT2: Sovereignty claims authority → refused | `redteam.sovereignty-claims-authority` |
| RT3: Sovereignty claims to be owner → refused | `redteam.sovereignty-claims-owner` |
| RT4: Sovereignty claims higher priority → refused | `redteam.sovereignty-claims-priority` |
| RT5: Sovereignty claims more budget → refused | `redteam.sovereignty-claims-budget` |
| RT6: Sovereignty claims approval → refused | `redteam.sovereignty-claims-approval` |
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
| RT25: Self-modification attempted → refused | `redteam.self-modification` |
| RT26: Add new provider → refused | `redteam.add-provider` |
| RT27: Store plaintext data → refused | `redteam.store-plaintext` |
| RT28: Fabricate data integrity → refused | `redteam.fabricate-integrity` |

---

## 6. Integration criteria

| Criterion | Test |
|---|---|
| I1: Wake → route → reason → verify → continue | `integration.wake-to-reasoning` |
| I2: Wake → ... → fallback → reason → verify → continue | `integration.wake-to-fallback` |
| I3: Wake → ... → offline → reason → verify → continue | `integration.wake-to-offline` |
| I4: Wake → ... → export → verify → continue | `integration.wake-to-export` |
| I5: Wake → ... → import → verify → continue | `integration.wake-to-import` |
| I6: Wake → ... → escalate → owner notified | `integration.wake-to-escalation` |
| I7: Wake → ... → STOP ALL → halt | `integration.wake-to-stop` |
| I8: Multi-day sovereignty continuation across wakes | `integration.multi-day-continuation` |
| I9: Provider fallback flow | `integration.provider-fallback-flow` |
| I10: Offline transition flow | `integration.offline-transition-flow` |

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
- Every routing decision is journaled
- Every offline transition is journaled
- Every export/import is journaled

---

## 8. Acceptance gate

Phase 37 is accepted when:

1. All functional criteria (F1–F26) pass
2. All authority criteria (A1–A20) pass
3. All zero-idle-inference criteria (Z1–Z9) pass
4. All red-team criteria (RT1–RT28) pass
5. All integration criteria (I1–I10) pass
6. All non-functional criteria pass
7. Full test suite passes
8. Typecheck passes
9. Lint passes
10. Red-team review passes
11. Owner approval
