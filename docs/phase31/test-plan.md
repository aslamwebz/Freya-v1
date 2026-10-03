# Phase 31 — Test Plan

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This test plan defines the testing strategy for Phase 31 Long-Horizon
Autonomy. It covers unit tests, integration tests, red-team tests,
zero-idle-inference tests, and restart recovery tests.

All tests are deterministic: same inputs + same clock = same output. No test
relies on randomness, wall-clock time, or external services.

---

## 2. Unit tests

### 2.1 Persistent goal tests

| Test | Description |
|---|---|
| `goals.survive-restart` | Goals are durable and survive restarts |
| `goals.have-completion-criteria` | Goals have explicit completion criteria |
| `goals.track-progress` | Goals track progress toward completion |
| `goals.have-dependencies` | Goals have dependencies on other goals |
| `goals.deterministic` | Same inputs + same clock = same goal state |
| `goals.no-model-calls` | Goal store never calls a model |
| `goals.state-transitions` | Goal state transitions are valid |
| `goals.invalid-transitions-refused` | Invalid goal state transitions are refused |
| `goals.progress-bounded` | Goal progress is always in [0, 1] |
| `goals.dependency-resolution` | Goal dependencies are resolved correctly |

### 2.2 Bounded scheduler tests

| Test | Description |
|---|---|
| `scheduler.host-driven` | Schedules are host-driven, not self-scheduling |
| `scheduler.deterministic` | Same inputs + same clock = same schedule |
| `scheduler.enforces-limits` | Schedule limits are enforced |
| `scheduler.no-model-calls` | Scheduler never calls a model |
| `scheduler.idempotent` | Repeated schedules do not produce duplicate events |
| `scheduler.fail-closed` | STOP ALL or corrupt journal halts the scheduler |
| `scheduler.condition-evaluation` | Schedule conditions are evaluated correctly |
| `scheduler.goal-open-condition` | `goal-open` condition checks goal state |

### 2.3 Long-horizon continuation tests

| Test | Description |
|---|---|
| `continuation.event-driven` | Continuation is event-driven, not polling |
| `continuation.bounded` | Continuation is bounded by deadlines |
| `continuation.deterministic` | Same inputs + same clock = same continuation |
| `continuation.no-model-calls` | Continuation never calls a model |
| `continuation.checkpoint-verification` | Checkpoints are verified before continuing |
| `continuation.interrupted-goal-recovery` | Interrupted goals are reconciled |

### 2.4 Verification tests

| Test | Description |
|---|---|
| `verification.every-checkpoint-verified` | Every checkpoint is verified |
| `verification.bounded` | Verification is bounded by deadlines |
| `verification.deterministic` | Same inputs + same clock = same verification |
| `verification.retry-ceiling` | Retry ceilings are enforced |
| `verification.backoff-bounded` | Backoff is bounded by maximum |
| `verification.outcomes-journaled` | Verification outcomes are journaled |

### 2.5 Uncertainty tests

| Test | Description |
|---|---|
| `uncertainty.assumptions-explicit` | Assumptions are explicit |
| `uncertainty.assumptions-have-expiration` | Assumptions have expiration times |
| `uncertainty.stale-evidence-detected` | Stale evidence is detected and marked |
| `uncertainty.conflicted-evidence-preserved` | Conflicted evidence is preserved |
| `uncertainty.confidence-not-fabricated` | Confidence is never fabricated |
| `uncertainty.conservative-interpretation` | Conflicted evidence uses conservative interpretation |

### 2.6 Long-horizon state tests

| Test | Description |
|---|---|
| `state.computed` | Long-horizon state is computed from durable state |
| `state.explainable` | Every item carries reasoning |
| `state.honest-about-uncertainty` | Uncertainty is never hidden |
| `state.no-fabricated-confidence` | Confidence is never fabricated |
| `state.bounded` | Lists and strings are bounded |
| `state.deterministic` | Same inputs + same clock = same state |
| `state.no-model-calls` | Long-horizon state never calls a model |

---

## 3. Integration tests

### 3.1 Full long-horizon flow

| Test | Description |
|---|---|
| `integration.wake-to-decision` | Wake → filter → schedule → continue → state |
| `integration.wake-to-action` | Wake → filter → schedule → continue → delegate → execute |
| `integration.wake-to-verification` | Wake → ... → execute → verify → continue |
| `integration.wake-to-escalation` | Wake → ... → escalate → owner notified |
| `integration.wake-to-stop` | Wake → ... → STOP ALL → halt |
| `integration.multi-day-continuation` | Multi-day goal continuation across wakes |
| `integration.multi-week-continuation` | Multi-week goal continuation across wakes |
| `integration.goal-dependency-resolution` | Goal dependency resolution |
| `integration.checkpoint-verification` | Checkpoint verification flow |
| `integration.interrupted-goal-recovery` | Interrupted goal recovery |

### 3.2 Authority preservation tests

| Test | Description |
|---|---|
| `authority.guard-not-bypassed` | Guard capability checks are never bypassed |
| `authority.governor-not-bypassed` | Governor cognition authorization is never bypassed |
| `authority.stop-all-respected` | STOP ALL immediately halts everything |
| `authority.budgets-respected` | Budget limits are never exceeded |
| `authority.approvals-respected` | Approval requirements are never skipped |
| `authority.no-self-approval` | Goals cannot approve their own requests |
| `authority.no-grant-creation` | Goals cannot create grants |
| `authority.no-capability-widening` | Goals cannot widen capabilities |
| `authority.no-real-money-actions` | No real-money/economic actions are performed |
| `authority.no-spending-authority` | No spending authority is added |

---

## 4. Red-team tests

### 4.1 Authority escalation attempts

| Test | Description |
|---|---|
| `redteam.goal-claims-capability` | Goal claims a capability it does not hold → refused |
| `redteam.goal-claims-authority` | Goal claims authority it does not have → refused |
| `redteam.goal-claims-owner` | Goal claims to be the owner → refused |
| `redteam.goal-claims-priority` | Goal claims higher priority → refused |
| `redteam.goal-claims-budget` | Goal claims more budget → refused |
| `redteam.goal-claims-approval` | Goal claims approval it does not have → refused |
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
| `restart.goals-survive` | Goals survive restarts |
| `restart.checkpoints-survive` | Checkpoints survive restarts |
| `restart.schedules-survive` | Schedules survive restarts |
| `restart.grants-survive` | Grants survive restarts |
| `restart.stop-all-survives` | STOP ALL survives restarts |
| `restart.no-silent-continuation` | No silent continuation occurs |
| `restart.no-fabricated-state` | No state is fabricated on restart |
| `restart.deterministic` | Same journal + same clock = same state |
| `restart.no-hidden-state` | No hidden state survives restart |

### 6.2 Interrupted goal recovery

| Test | Description |
|---|---|
| `restart.interrupted-goal-reconciled` | Interrupted goals are reconciled |
| `restart.interrupted-goal-not-resumed` | Interrupted goals are not silently resumed |
| `restart.interrupted-goal-visible` | Interrupted goals are visible to owner |
| `restart.interrupted-goal-journaled` | Interrupted goals are journaled |

### 6.3 Multi-day span tests

| Test | Description |
|---|---|
| `restart.multi-day-goal-recovery` | Multi-day goals are recovered correctly |
| `restart.multi-day-goal-continuation` | Multi-day goals continue from where they left off |
| `restart.multi-week-goal-recovery` | Multi-week goals are recovered correctly |
| `restart.multi-week-goal-continuation` | Multi-week goals continue from where they left off |

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

- `createTestGoal()`: creates a test goal
- `createTestCheckpoint()`: creates a test checkpoint
- `createTestSchedule()`: creates a test schedule
- `createTestWakeEvent()`: creates a test wake event
- `createTestLongHorizonState()`: creates a test long-horizon state

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
| Persistent Goal Store | 95% | 90% |
| Bounded Scheduler | 95% | 90% |
| Long-Horizon Continuation | 95% | 90% |
| Verification | 95% | 90% |
| Uncertainty Handling | 95% | 90% |
| Long-Horizon State | 95% | 90% |
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
