# Phase 33 — Test Plan

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This test plan defines the testing strategy for Phase 33 Autonomous
Enterprise / Webzone. It covers unit tests, integration tests, red-team tests,
zero-idle-inference tests, and restart recovery tests.

All tests are deterministic: same inputs + same clock = same output. No test
relies on randomness, wall-clock time, or external services.

---

## 2. Unit tests

### 2.1 Business environment tests

| Test | Description |
|---|---|
| `environment.survive-restart` | Environments are durable and survive restarts |
| `environment.have-completion-criteria` | Environments have explicit completion criteria |
| `environment.track-progress` | Environments track progress toward completion |
| `environment.have-boundaries` | Environments have enterprise boundaries |
| `environment.have-spending-limits` | Environments have spending limits |
| `environment.deterministic` | Same inputs + same clock = same environment state |
| `environment.no-model-calls` | Environment store never calls a model |
| `environment.state-transitions` | Environment state transitions are valid |
| `environment.invalid-transitions-refused` | Invalid environment state transitions are refused |
| `environment.progress-bounded` | Environment progress is always in [0, 1] |

### 2.2 Enterprise boundary tests

| Test | Description |
|---|---|
| `boundaries.enforced` | Enterprise boundaries are enforced |
| `boundaries.deterministic` | Same inputs + same clock = same boundary check |
| `boundaries.journaled` | Boundary checks are journaled |
| `boundaries.cannot-be-widened` | Boundaries cannot be widened at runtime |
| `boundaries.violations-refused` | Boundary violations are refused |

### 2.3 Task and mission orchestration tests

| Test | Description |
|---|---|
| `tasks.bounded` | Tasks are bounded by deadlines |
| `missions.bounded` | Missions are bounded by deadlines |
| `tasks.deterministic` | Same inputs + same clock = same task state |
| `missions.deterministic` | Same inputs + same clock = same mission state |
| `tasks.no-model-calls` | Task orchestration never calls a model |
| `missions.no-model-calls` | Mission orchestration never calls a model |
| `tasks.dependency-resolution` | Task dependencies are resolved correctly |
| `missions.child-task-tracking` | Missions track child tasks correctly |

### 2.4 Webzone interface tests

| Test | Description |
|---|---|
| `webzone.bounded` | Webzone operations are bounded by duration |
| `webzone.auditable` | Webzone operations are auditable |
| `webzone.deterministic` | Same inputs + same clock = same webzone state |
| `webzone.no-model-calls` | Webzone interfaces never call a model |
| `webzone.respects-boundaries` | Webzone operations respect enterprise boundaries |
| `webzone.operation-limits-enforced` | Webzone operation limits are enforced |

### 2.5 Auditability tests

| Test | Description |
|---|---|
| `audit.decisions-journaled` | Every decision is journaled |
| `audit.actions-journaled` | Every action is journaled |
| `audit.refusals-journaled` | Every refusal is journaled |
| `audit.boundary-checks-journaled` | Every boundary check is journaled |
| `audit.spending-gate-checks-journaled` | Every spending gate check is journaled |
| `audit.verifications-journaled` | Every verification is journaled |
| `audit.rollbacks-journaled` | Every rollback is journaled |

### 2.6 Approval tests

| Test | Description |
|---|---|
| `approvals.explicit` | Approvals are explicit |
| `approvals.durable` | Approvals are durable |
| `approvals.auditable` | Approvals are auditable |
| `approvals.enforced` | Approvals are enforced |
| `approvals.never-skipped` | Approvals are never skipped |

### 2.7 Spending gate tests

| Test | Description |
|---|---|
| `spending-gates.enforced` | Spending gates are enforced |
| `spending-gates.deterministic` | Same inputs + same clock = same spending gate check |
| `spending-gates.journaled` | Spending gate checks are journaled |
| `spending-gates.cannot-be-widened` | Spending gates cannot be widened at runtime |
| `spending-gates.violations-refused` | Spending gate violations are refused |

### 2.8 External-action verification tests

| Test | Description |
|---|---|
| `verification.every-action-verified` | Every external action is verified |
| `verification.bounded` | Verification is bounded by deadlines |
| `verification.deterministic` | Same inputs + same clock = same verification |
| `verification.outcomes-journaled` | Verification outcomes are journaled |
| `verification.never-fabricates` | Verification never fabricates outcomes |

### 2.9 Rollback/recovery tests

| Test | Description |
|---|---|
| `rollback.reversible-actions-rolled-back` | Reversible actions can be rolled back |
| `rollback.irreversible-actions-refused` | Irreversible actions cannot be rolled back |
| `rollback.bounded` | Rollback is bounded by duration |
| `rollback.deterministic` | Same inputs + same clock = same rollback |
| `rollback.outcomes-journaled` | Rollback outcomes are journaled |

### 2.10 Enterprise state tests

| Test | Description |
|---|---|
| `state.computed` | Enterprise state is computed from durable state |
| `state.explainable` | Every item carries reasoning |
| `state.honest-about-uncertainty` | Uncertainty is never hidden |
| `state.no-fabricated-confidence` | Confidence is never fabricated |
| `state.bounded` | Lists and strings are bounded |
| `state.deterministic` | Same inputs + same clock = same state |
| `state.no-model-calls` | Enterprise state never calls a model |

---

## 3. Integration tests

### 3.1 Full enterprise flow

| Test | Description |
|---|---|
| `integration.wake-to-decision` | Wake → filter → environment → orchestrate → webzone → state |
| `integration.wake-to-verification` | Wake → ... → verify → continue |
| `integration.wake-to-escalation` | Wake → ... → escalate → owner notified |
| `integration.wake-to-stop` | Wake → ... → STOP ALL → halt |
| `integration.multi-day-continuation` | Multi-day environment continuation across wakes |
| `integration.environment-dependency-resolution` | Environment dependency resolution |
| `integration.webzone-verification` | Webzone operation verification flow |
| `integration.interrupted-environment-recovery` | Interrupted environment recovery |
| `integration.rollback-flow` | Rollback flow |
| `integration.spending-gate-flow` | Spending gate enforcement flow |

### 3.2 Authority preservation tests

| Test | Description |
|---|---|
| `authority.guard-not-bypassed` | Guard capability checks are never bypassed |
| `authority.governor-not-bypassed` | Governor cognition authorization is never bypassed |
| `authority.stop-all-respected` | STOP ALL immediately halts everything |
| `authority.budgets-respected` | Budget limits are never exceeded |
| `authority.approvals-respected` | Approval requirements are never skipped |
| `authority.no-self-approval` | Environments cannot approve their own requests |
| `authority.no-grant-creation` | Environments cannot create grants |
| `authority.no-capability-widening` | Environments cannot widen capabilities |
| `authority.no-real-money-actions` | No real-money/economic actions are performed |
| `authority.no-spending-authority` | No spending authority is added |
| `authority.no-real-orders` | No real orders are placed |

---

## 4. Red-team tests

### 4.1 Authority escalation attempts

| Test | Description |
|---|---|
| `redteam.environment-claims-capability` | Environment claims a capability it does not hold → refused |
| `redteam.environment-claims-authority` | Environment claims authority it does not have → refused |
| `redteam.environment-claims-owner` | Environment claims to be the owner → refused |
| `redteam.environment-claims-priority` | Environment claims higher priority → refused |
| `redteam.environment-claims-budget` | Environment claims more budget → refused |
| `redteam.environment-claims-approval` | Environment claims approval it does not have → refused |
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
| `redteam.exceed-spending-gate` | Attempt to exceed spending gate → refused |
| `redteam.cross-enterprise-boundary` | Attempt to cross enterprise boundary → refused |
| `redteam.rollback-irreversible` | Attempt to rollback irreversible action → refused |
| `redteam.fabricate-verification` | Attempt to fabricate verification outcome → refused |

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
| `restart.environments-survive` | Environments survive restarts |
| `restart.tasks-survive` | Tasks survive restarts |
| `restart.missions-survive` | Missions survive restarts |
| `restart.webzone-operations-survive` | Webzone operations survive restarts |
| `restart.stop-all-survives` | STOP ALL survives restarts |
| `restart.no-silent-continuation` | No silent continuation occurs |
| `restart.no-fabricated-state` | No state is fabricated on restart |
| `restart.deterministic` | Same journal + same clock = same state |
| `restart.no-hidden-state` | No hidden state survives restart |

### 6.2 Interrupted environment recovery

| Test | Description |
|---|---|
| `restart.interrupted-environment-reconciled` | Interrupted environments are reconciled |
| `restart.interrupted-environment-not-resumed` | Interrupted environments are not silently resumed |
| `restart.interrupted-environment-visible` | Interrupted environments are visible to owner |
| `restart.interrupted-environment-journaled` | Interrupted environments are journaled |

### 6.3 Rollback recovery tests

| Test | Description |
|---|---|
| `restart.interrupted-rollback-reconciled` | Interrupted rollbacks are reconciled |
| `restart.interrupted-rollback-not-resumed` | Interrupted rollbacks are not silently resumed |
| `restart.interrupted-rollback-visible` | Interrupted rollbacks are visible to owner |
| `restart.interrupted-rollback-journaled` | Interrupted rollbacks are journaled |

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

- `createTestEnvironment()`: creates a test environment
- `createTestTask()`: creates a test task
- `createTestMission()`: creates a test mission
- `createTestWebzoneOperation()`: creates a test webzone operation
- `createTestWakeEvent()`: creates a test wake event
- `createTestEnterpriseState()`: creates a test enterprise state

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
| Business Environment | 95% | 90% |
| Enterprise Boundaries | 95% | 90% |
| Task/Mission Orchestration | 95% | 90% |
| Webzone Interfaces | 95% | 90% |
| Auditability | 95% | 90% |
| Approvals | 95% | 90% |
| Spending Gates | 95% | 90% |
| External-Action Verification | 95% | 90% |
| Rollback/Recovery | 95% | 90% |
| Enterprise State | 95% | 90% |
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
