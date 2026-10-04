# Phase 32 — Test Plan

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This test plan defines the testing strategy for Phase 32 Economic
Intelligence. It covers unit tests, integration tests, red-team tests,
zero-idle-inference tests, and restart recovery tests.

All tests are deterministic: same inputs + same clock = same output. No test
relies on randomness, wall-clock time, or external services.

---

## 2. Unit tests

### 2.1 Research engine tests

| Test | Description |
|---|---|
| `research.bounded` | Research is bounded by scope and deadline |
| `research.evidence-sourced` | Every piece of evidence has an authorized source |
| `research.evidence-cited` | Every piece of evidence has a citation |
| `research.evidence-freshness-tracked` | Evidence freshness is tracked |
| `research.deterministic` | Same inputs + same clock = same research |
| `research.no-model-calls` | Research engine never calls a model |
| `research.no-real-money-actions` | Research performs no real-money actions |
| `research.stale-evidence-detected` | Stale evidence is detected and marked |
| `research.conflicted-evidence-preserved` | Conflicted evidence is preserved |

### 2.2 Simulation engine tests

| Test | Description |
|---|---|
| `simulation.bounded` | Simulation is bounded by duration |
| `simulation.scenarios-deterministic` | Same parameters + same clock = same result |
| `simulation.results-carry-assumptions` | Results carry explicit assumptions |
| `simulation.deterministic` | Same inputs + same clock = same simulation |
| `simulation.no-model-calls` | Simulation engine never calls a model |
| `simulation.no-real-money-actions` | Simulation performs no real-money actions |
| `simulation.scenario-limits-enforced` | Scenario limits are enforced |

### 2.3 Paper trading engine tests

| Test | Description |
|---|---|
| `paper-trading.orders-simulated` | Paper orders are simulated, not real |
| `paper-trading.no-real-orders` | No real orders are placed |
| `paper-trading.portfolio-tracked` | Paper portfolio is tracked |
| `paper-trading.metrics-have-denominators` | Metrics have explicit denominators |
| `paper-trading.metrics-have-units` | Metrics have units |
| `paper-trading.deterministic` | Same inputs + same clock = same result |
| `paper-trading.no-model-calls` | Paper trading engine never calls a model |
| `paper-trading.no-real-money-actions` | Paper trading performs no real-money actions |
| `paper-trading.order-limits-enforced` | Order limits are enforced |

### 2.4 Economic state tests

| Test | Description |
|---|---|
| `state.computed` | Economic state is computed from durable state |
| `state.explainable` | Every item carries reasoning |
| `state.honest-about-uncertainty` | Uncertainty is never hidden |
| `state.no-fabricated-confidence` | Confidence is never fabricated |
| `state.bounded` | Lists and strings are bounded |
| `state.deterministic` | Same inputs + same clock = same state |
| `state.no-model-calls` | Economic state never calls a model |

---

## 3. Integration tests

### 3.1 Full economic intelligence flow

| Test | Description |
|---|---|
| `integration.wake-to-decision` | Wake → filter → research → simulate → paper-trade → state |
| `integration.wake-to-verification` | Wake → ... → verify → continue |
| `integration.wake-to-escalation` | Wake → ... → escalate → owner notified |
| `integration.wake-to-stop` | Wake → ... → STOP ALL → halt |
| `integration.multi-day-continuation` | Multi-day experiment continuation across wakes |
| `integration.experiment-dependency-resolution` | Experiment dependency resolution |
| `integration.paper-order-verification` | Paper order verification flow |
| `integration.interrupted-experiment-recovery` | Interrupted experiment recovery |

### 3.2 Authority preservation tests

| Test | Description |
|---|---|
| `authority.guard-not-bypassed` | Guard capability checks are never bypassed |
| `authority.governor-not-bypassed` | Governor cognition authorization is never bypassed |
| `authority.stop-all-respected` | STOP ALL immediately halts everything |
| `authority.budgets-respected` | Budget limits are never exceeded |
| `authority.approvals-respected` | Approval requirements are never skipped |
| `authority.no-self-approval` | Experiments cannot approve their own requests |
| `authority.no-grant-creation` | Experiments cannot create grants |
| `authority.no-capability-widening` | Experiments cannot widen capabilities |
| `authority.no-real-money-actions` | No real-money/economic actions are performed |
| `authority.no-spending-authority` | No spending authority is added |
| `authority.no-real-orders` | No real orders are placed |

---

## 4. Red-team tests

### 4.1 Authority escalation attempts

| Test | Description |
|---|---|
| `redteam.experiment-claims-capability` | Experiment claims a capability it does not hold → refused |
| `redteam.experiment-claims-authority` | Experiment claims authority it does not have → refused |
| `redteam.experiment-claims-owner` | Experiment claims to be the owner → refused |
| `redteam.experiment-claims-priority` | Experiment claims higher priority → refused |
| `redteam.experiment-claims-budget` | Experiment claims more budget → refused |
| `redteam.experiment-claims-approval` | Experiment claims approval it does not have → refused |
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
| `restart.experiments-survive` | Experiments survive restarts |
| `restart.evidence-survives` | Evidence survives restarts |
| `restart.simulations-survive` | Simulations survive restarts |
| `restart.paper-orders-survive` | Paper orders survive restarts |
| `restart.stop-all-survives` | STOP ALL survives restarts |
| `restart.no-silent-continuation` | No silent continuation occurs |
| `restart.no-fabricated-state` | No state is fabricated on restart |
| `restart.deterministic` | Same journal + same clock = same state |
| `restart.no-hidden-state` | No hidden state survives restart |

### 6.2 Interrupted experiment recovery

| Test | Description |
|---|---|
| `restart.interrupted-experiment-reconciled` | Interrupted experiments are reconciled |
| `restart.interrupted-experiment-not-resumed` | Interrupted experiments are not silently resumed |
| `restart.interrupted-experiment-visible` | Interrupted experiments are visible to owner |
| `restart.interrupted-experiment-journaled` | Interrupted experiments are journaled |

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

- `createTestExperiment()`: creates a test experiment
- `createTestEvidence()`: creates a test evidence
- `createTestScenario()`: creates a test scenario
- `createTestPaperOrder()`: creates a test paper order
- `createTestWakeEvent()`: creates a test wake event
- `createTestEconomicState()`: creates a test economic state

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
| Research Engine | 95% | 90% |
| Simulation Engine | 95% | 90% |
| Paper Trading Engine | 95% | 90% |
| Economic State | 95% | 90% |
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
