# Phase 36 — Acceptance Criteria

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

These acceptance criteria define the conditions that must be met for Phase 36
to be considered complete. They are the gate between preparation and
implementation.

Each criterion is testable and auditable. A criterion is met when its test
passes and its invariant holds.

---

## 2. Functional criteria

### 2.1 Crash recovery

| Criterion | Test |
|---|---|
| F1: Crash recovery is bounded | `crash-recovery.bounded` |
| F2: Crash recovery is deterministic | `crash-recovery.deterministic` |
| F3: Crash recovery is journaled | `crash-recovery.journaled` |
| F4: Crash recovery never fabricates state | `crash-recovery.never-fabricates` |
| F5: Crash recovery never silently continues | `crash-recovery.never-silently-continues` |
| F6: Crash recovery never calls a model | `crash-recovery.no-model-calls` |

### 2.2 Data failure recovery

| Criterion | Test |
|---|---|
| F7: Data failure recovery is bounded | `data-failure-recovery.bounded` |
| F8: Data failure recovery is deterministic | `data-failure-recovery.deterministic` |
| F9: Data failure recovery is journaled | `data-failure-recovery.journaled` |
| F10: Data failure recovery never fabricates data | `data-failure-recovery.never-fabricates` |
| F11: Data failure recovery never hides corruption | `data-failure-recovery.never-hides` |
| F12: Data failure recovery never calls a model | `data-failure-recovery.no-model-calls` |

### 2.3 Provider failure recovery

| Criterion | Test |
|---|---|
| F13: Provider failure recovery is bounded | `provider-failure-recovery.bounded` |
| F14: Provider failure recovery is deterministic | `provider-failure-recovery.deterministic` |
| F15: Provider failure recovery is journaled | `provider-failure-recovery.journaled` |
| F16: Provider failure recovery never adds providers | `provider-failure-recovery.never-adds-providers` |
| F17: Provider failure recovery never exceeds retry ceiling | `provider-failure-recovery.never-exceeds-retry` |
| F18: Provider failure recovery never calls a model | `provider-failure-recovery.no-model-calls` |

### 2.4 Backup restore

| Criterion | Test |
|---|---|
| F19: Backup restore is bounded | `backup-restore.bounded` |
| F20: Backup restore is deterministic | `backup-restore.deterministic` |
| F21: Backup restore is journaled | `backup-restore.journaled` |
| F22: Backup restore never stores plaintext | `backup-restore.never-stores-plaintext` |
| F23: Backup restore never fabricates state | `backup-restore.never-fabricates` |
| F24: Backup restore is verified | `backup-restore.verified` |

### 2.5 Degraded-mode honesty

| Criterion | Test |
|---|---|
| F25: Degraded mode is truthful | `degraded-mode.truthful` |
| F26: Degraded mode is bounded | `degraded-mode.bounded` |
| F27: Degraded mode is deterministic | `degraded-mode.deterministic` |
| F28: Degraded mode is journaled | `degraded-mode.journaled` |
| F29: Degraded mode never fabricates capability | `degraded-mode.never-fabricates` |
| F30: Degraded mode is always visible | `degraded-mode.always-visible` |

### 2.6 Repair workflows

| Criterion | Test |
|---|---|
| F31: Repair workflows are bounded | `repair-workflows.bounded` |
| F32: Repair workflows are deterministic | `repair-workflows.deterministic` |
| F33: Repair workflows are journaled | `repair-workflows.journaled` |
| F34: Repair workflows are authorized | `repair-workflows.authorized` |
| F35: Repair workflows are verified | `repair-workflows.verified` |
| F36: Repair workflows never self-modify | `repair-workflows.never-self-modify` |

### 2.7 Resilience state

| Criterion | Test |
|---|---|
| F37: Resilience state is computed from durable state | `state.computed` |
| F38: Resilience state is explainable | `state.explainable` |
| F39: Resilience state is honest about uncertainty | `state.honest-about-uncertainty` |
| F40: Resilience state is bounded | `state.bounded` |
| F41: Resilience state is deterministic | `state.deterministic` |
| F42: Resilience state never calls a model | `state.no-model-calls` |

---

## 3. Authority criteria

### 3.1 Guard

| Criterion | Test |
|---|---|
| A1: Guard capability checks are never bypassed | `authority.guard-not-bypassed` |
| A2: Recovery cannot be assigned capabilities it does not hold | `redteam.recovery-claims-capability` |

### 3.2 Governor

| Criterion | Test |
|---|---|
| A3: Governor cognition authorization is never bypassed | `authority.governor-not-bypassed` |
| A4: Recovery cannot request cognition without a grant | `redteam.recovery-claims-authority` |

### 3.3 STOP ALL

| Criterion | Test |
|---|---|
| A5: STOP ALL immediately halts everything | `authority.stop-all-respected` |
| A6: STOP ALL cannot be bypassed | `redteam.bypass-stop-all` |

### 3.4 Budgets

| Criterion | Test |
|---|---|
| A7: Budget limits are never exceeded | `authority.budgets-respected` |
| A8: Recovery cannot claim more budget | `redteam.recovery-claims-budget` |

### 3.5 Approvals

| Criterion | Test |
|---|---|
| A9: Approval requirements are never skipped | `authority.approvals-respected` |
| A10: Recovery cannot approve its own requests | `authority.no-self-approval` |
| A11: Recovery cannot claim approval | `redteam.recovery-claims-approval` |

### 3.6 Grants

| Criterion | Test |
|---|---|
| A12: Recovery cannot create grants | `authority.no-grant-creation` |
| A13: Only the owner may create grants | `redteam.create-grant` |

### 3.7 Capabilities

| Criterion | Test |
|---|---|
| A14: Capabilities are never widened beyond code-owned ceilings | `authority.no-capability-widening` |
| A15: Recovery cannot widen its own capabilities | `redteam.widen-capability` |

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
| RT1: Recovery claims capability → refused | `redteam.recovery-claims-capability` |
| RT2: Recovery claims authority → refused | `redteam.recovery-claims-authority` |
| RT3: Recovery claims to be owner → refused | `redteam.recovery-claims-owner` |
| RT4: Recovery claims higher priority → refused | `redteam.recovery-claims-priority` |
| RT5: Recovery claims more budget → refused | `redteam.recovery-claims-budget` |
| RT6: Recovery claims approval → refused | `redteam.recovery-claims-approval` |
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
| RT26: Fabricate recovery outcome → refused | `redteam.fabricate-recovery` |
| RT27: Hide degradation → detected | `redteam.hide-degradation` |
| RT28: Fabricate capability → detected | `redteam.fabricate-capability` |

---

## 6. Integration criteria

| Criterion | Test |
|---|---|
| I1: Wake → detect → recover → verify → continue | `integration.wake-to-recovery` |
| I2: Wake → detect → repair → verify → continue | `integration.wake-to-repair` |
| I3: Wake → ... → escalate → owner notified | `integration.wake-to-escalation` |
| I4: Wake → ... → STOP ALL → halt | `integration.wake-to-stop` |
| I5: Multi-day recovery continuation across wakes | `integration.multi-day-recovery` |
| I6: Backup/restore flow | `integration.backup-restore-flow` |
| I7: Degraded-mode transition flow | `integration.degraded-mode-flow` |
| I8: Interrupted recovery reconciliation | `integration.interrupted-recovery-reconciliation` |
| I9: Provider fallback flow | `integration.provider-fallback-flow` |
| I10: Self-modification refusal flow | `integration.self-modification-refusal-flow` |

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
- Every recovery is journaled
- Every repair is journaled
- Every backup/restore is journaled
- Every degraded-mode transition is journaled

---

## 8. Acceptance gate

Phase 36 is accepted when:

1. All functional criteria (F1–F42) pass
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
