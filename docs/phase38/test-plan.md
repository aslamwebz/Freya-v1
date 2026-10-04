# Phase 38 — Test Plan

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This test plan defines the testing strategy for Phase 38 Cognitive Evolution.
It covers unit tests, integration tests, red-team tests, zero-idle-inference
tests, and restart recovery tests.

All tests are deterministic: same inputs + same clock = same output. No test
relies on randomness, wall-clock time, or external services.

---

## 2. Unit tests

### 2.1 Evidence-driven improvement tests

| Test | Description |
|---|---|
| `evidence.verified` | Evidence is verified |
| `evidence.quality-assessed` | Evidence quality is assessed |
| `evidence.bounded` | Evidence is bounded by deadlines |
| `evidence.deterministic` | Same evidence + same clock = same verification |
| `evidence.journaled` | Evidence is journaled |
| `evidence.never-fabricated` | Evidence is never fabricated |

### 2.2 Planning/reasoning/learning improvement tests

| Test | Description |
|---|---|
| `planning-improvement.bounded` | Planning improvement is bounded by deadlines |
| `reasoning-improvement.bounded` | Reasoning improvement is bounded by deadlines |
| `learning-improvement.bounded` | Learning improvement is bounded by deadlines |
| `improvements.deterministic` | Same evidence + same clock = same improvement |
| `improvements.journaled` | Improvements are journaled |
| `improvements.evidence-driven` | Improvements are evidence-driven |
| `improvements.reversible` | Improvements are reversible |

### 2.3 Authority drift prevention tests

| Test | Description |
|---|---|
| `drift-detection.detected` | Drift is detected |
| `drift-prevention.prevented` | Drift is prevented |
| `drift-checks.bounded` | Drift checks are bounded by deadlines |
| `drift-checks.deterministic` | Same action + same boundaries = same check |
| `drift-checks.journaled` | Drift checks are journaled |
| `authority.never-widened` | Authority is never widened |
| `self-modification.prevented` | Self-modification is prevented |

### 2.4 Evolution state tests

| Test | Description |
|---|---|
| `state.computed` | Evolution state is computed from durable state |
| `state.explainable` | Every item carries reasoning |
| `state.honest-about-uncertainty` | Uncertainty is never hidden |
| `state.no-fabricated-confidence` | Confidence is never fabricated |
| `state.bounded` | Lists and strings are bounded |
| `state.deterministic` | Same inputs + same clock = same state |
| `state.no-model-calls` | Evolution state never calls a model |

---

## 3. Integration tests

### 3.1 Full evolution flow

| Test | Description |
|---|---|
| `integration.wave-to-improvement` | Wake → evaluate → improve → verify → apply |
| `integration.wave-to-drift-denial` | Wake → ... → drift detected → deny |
| `integration.wake-to-escalation` | Wake → ... → escalate → owner notified |
| `integration.wake-to-stop` | Wake → ... → STOP ALL → halt |
| `integration.multi-day-evolution` | Multi-day evolution continuation across wakes |
| `integration.improvement-staging-flow` | Improvement staging flow |
| `integration.drift-prevention-flow` | Authority drift prevention flow |
| `integration.interrupted-improvement-reconciliation` | Interrupted improvement reconciliation |
| `integration.evidence-verification-flow` | Evidence verification flow |
| `integration.self-modification-refusal-flow` | Self-modification refusal flow |

### 3.2 Authority preservation tests

| Test | Description |
|---|---|
| `authority.guard-not-bypassed` | Guard capability checks are never bypassed |
| `authority.governor-not-bypassed` | Governor cognition authorization is never bypassed |
| `authority.stop-all-respected` | STOP ALL immediately halts everything |
| `authority.budgets-respected` | Budget limits are never exceeded |
| `authority.approvals-respected` | Approval requirements are never skipped |
| `authority.no-self-approval` | Evolution cannot approve its own requests |
| `authority.no-grant-creation` | Evolution cannot create grants |
| `authority.no-capability-widening` | Evolution cannot widen capabilities |
| `authority.no-real-money-actions` | No real-money/economic actions are performed |
| `authority.no-spending-authority` | No spending authority is added |
| `authority.no-real-orders` | No real orders are placed |
| `authority.no-self-modification` | No trusted runtime code is self-modified |
| `authority.no-authority-drift` | Authority drift is never detected |

---

## 4. Red-team tests

### 4.1 Authority escalation attempts

| Test | Description |
|---|---|
| `redteam.evolution-claims-capability` | Evolution claims a capability it does not hold → refused |
| `redteam.evolution-claims-authority` | Evolution claims authority it does not have → refused |
| `redteam.evolution-claims-owner` | Evolution claims to be the owner → refused |
| `redteam.evolution-claims-priority` | Evolution claims higher priority → refused |
| `redteam.evolution-claims-budget` | Evolution claims more budget → refused |
| `redteam.evolution-claims-approval` | Evolution claims approval it does not have → refused |
| `redteam.model-claims-urgency` | Model output claims urgency → data, not authority |
| `redteam.model-claims-priority` | Model output claims priority → data, not authority |
| `redteam.model-claims-outcome` | Model output claims outcome → data, not authority |
| `redteam.event-claims-importance` | Event claims importance → data, not authority |
| `redteam.event-claims-deadline` | Event claims deadline → data, not authority |
| `redteam.context-claims-authority` | Context claims authority → data, not authority |

### 4.2 Boundary violation attempts

| Test | Description |
|---|---|
| `redteam.bypass-guard` | Attempt to bypass Guard → refused |
| `redteam.bypass-governor` | Attempt to bypass Governor → refused |
| `redteam.bypass-stop-all` | Attempt to bypass STOP ALL → refused |
| `redteam.exceed-budget` | Attempt to exceed budget → refused |
| `redteam.skip-approval` | Attempt to skip approval → refused |
| `redteam.widen-capability` | Attempt to widen capability → refused |
| `redteam.create-grant` | Attempt to create grant → refused |
| `redteam.self-approve` | Attempt to self-approve → refused |
| `redteam.hidden-inference` | Attempt to hide inference → detected |
| `redteam.continuous-polling` | Attempt to poll continuously → detected |
| `redteam.real-money-action` | Attempt real-money action → refused |
| `redteam.real-order-attempted` | Attempt real order → refused |
| `redteam.self-modification` | Attempt self-modification → refused |
| `redteam.authority-drift` | Attempt authority drift → refused |
| `redteam.fabricate-evidence` | Attempt to fabricate evidence → refused |
| `redteam.unauthorized-improvement` | Attempt unauthorized improvement → refused |

---

## 5. Zero-idle-inference tests

### 5.1 No model call without wake

| Test | Description |
|---|---|
| `zero-idle.no-model-call-without-wake` | No model call occurs without a wake event |
| `zero-idle.no-continuous-polling` | No continuous polling occurs |
| `zero-idle.no-hidden-reasoning` | No hidden reasoning occurs |
| `zero-idle.no-unrestricted-loops` | No unrestricted loops occur |
| `zero-idle.no-idle-model-call` | No model call occurs while idle |
| `zero-idle.no-background-reasoning` | No background reasoning occurs |
| `zero-idle.no-hidden-durable-state` | No hidden durable state is created |

### 5.2 Wake source validation

| Test | Description |
|---|---|
| `zero-idle.authorized-wake-sources` | Only authorized wake sources are accepted |
| `zero-idle.unauthorized-wake-refused` | Unauthorized wake sources are refused |
| `zero-idle.wake-from-renderer` | Wake from renderer is accepted (owner-interaction) |
| `zero-idle.wake-from-event` | Wake from authorized event is accepted |
| `zero-idle.wake-from-heartbeat` | Wake from scheduled heartbeat is accepted |
| `zero-idle.wake-from-mission` | Wake from mission transition is accepted |
| `zero-idle.wake-from-work` | Wake from work transition is accepted |

---

## 6. Restart recovery tests

### 6.1 Event-driven resumption

| Test | Description |
|---|---|
| `restart.evolution-survives` | Evolution state survives restarts |
| `restart.improvements-survive` | Improvements survive restarts |
| `restart.evidence-survives` | Evidence survives restarts |
| `restart.stop-all-survives` | STOP ALL survives restarts |
| `restart.no-silent-continuation` | No silent continuation occurs |
| `restart.no-fabricated-state` | No state is fabricated on restart |
| `restart.deterministic` | Same journal + same clock = same state |
| `restart.no-hidden-state` | No hidden state survives restart |

### 6.2 Interrupted improvement tests

| Test | Description |
|---|---|
| `restart.interrupted-improvement-reconciled` | Interrupted improvements are reconciled |
| `restart.interrupted-improvement-not-resumed` | Interrupted improvements are not silently resumed |
| `restart.interrupted-improvement-visible` | Interrupted improvements are visible to owner |
| `restart.interrupted-improvement-journaled` | Interrupted improvements are journaled |

### 6.3 Self-modification tests

| Test | Description |
|---|---|
| `restart.no-self-modification` | No self-modification occurs on restart |
| `restart.self-modification-refused` | Self-modification attempts are refused |
| `restart.self-modification-journaled` | Self-modification attempts are journaled |

---

## 7. Test infrastructure

### 7.1 Test doubles

- `FakeClock`: deterministic clock for testing
- `FakeJournal`: in-memory journal for testing
- `FakeWorker`: fake worker for testing
- `FakeModelProvider`: fake model provider for testing
- `FakeGuard`: fake Guard for testing
- `FakeGovernor`: fake Governor for testing

### 7.2 Test helpers

- `createTestEvidence()`: creates a test evidence record
- `createTestImprovement()`: creates a test improvement record
- `createTestDriftCheck()`: creates a test drift check record
- `createTestWakeEvent()`: creates a test wake event
- `createTestEvolutionState()`: creates a test evolution state

### 7.3 Test conventions

- All tests are synchronous unless testing async behavior
- All tests use injected clock, never `Date.now()`
- All tests use injected journal, never a real file
- All tests use injected model provider, never a real model
- All tests are deterministic and repeatable

---

## 8. Coverage targets

| Component | Line coverage | Branch coverage |
|---|---|---|
| Evidence-Driven Improvement | 95% | 90% |
| Planning/Reasoning/Learning | 95% | 90% |
| Authority Drift Prevention | 95% | 90% |
| Evolution State | 95% | 90% |
| Authority Preservation | 100% | 100% |
| Zero Idle Inference | 100% | 100% |
| Restart Recovery | 95% | 90% |

---

## 9. Test execution

Tests are run as part of the standard verification gate:

```bash
npm test
```

All tests must pass before the phase is considered complete.
