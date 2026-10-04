# Phase 36 — Test Plan

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This test plan defines the testing strategy for Phase 36 Resilience &
Self-Recovery. It covers unit tests, integration tests, red-team tests,
zero-idle-inference tests, and restart recovery tests.

All tests are deterministic: same inputs + same clock = same output. No test
relies on randomness, wall-clock time, or external services.

---

## 2. Unit tests

### 2.1 Crash recovery tests

| Test | Description |
|---|---|
| `crash-recovery.bounded` | Crash recovery is bounded by deadlines |
| `crash-recovery.deterministic` | Same journal + same clock = same recovery |
| `crash-recovery.journaled` | Crash recovery is journaled |
| `crash-recovery.never-fabricates` | Crash recovery never fabricates state |
| `crash-recovery.never-silently-continues` | Crash recovery never silently continues |
| `crash-recovery.no-model-calls` | Crash recovery never calls a model |
| `crash-recovery.state-rebuild` | State is rebuilt from journal |
| `crash-recovery.interrupted-operation-reconciliation` | Interrupted operations are reconciled |

### 2.2 Data failure recovery tests

| Test | Description |
|---|---|
| `data-failure-recovery.bounded` | Data failure recovery is bounded by deadlines |
| `data-failure-recovery.deterministic` | Same data + same clock = same recovery |
| `data-failure-recovery.journaled` | Data failure recovery is journaled |
| `data-failure-recovery.never-fabricates` | Data failure recovery never fabricates data |
| `data-failure-recovery.never-hides` | Data failure recovery never hides corruption |
| `data-failure-recovery.no-model-calls` | Data failure recovery never calls a model |
| `data-failure-recovery.quarantine` | Corrupt data is quarantined |
| `data-failure-recovery.trusted-prefix-replay` | Trusted prefix is replayed |

### 2.3 Provider failure recovery tests

| Test | Description |
|---|---|
| `provider-failure-recovery.bounded` | Provider failure recovery is bounded by deadlines |
| `provider-failure-recovery.deterministic` | Same state + same clock = same recovery |
| `provider-failure-recovery.journaled` | Provider failure recovery is journaled |
| `provider-failure-recovery.never-adds-providers` | Provider failure recovery never adds providers |
| `provider-failure-recovery.never-exceeds-retry` | Provider failure recovery never exceeds retry ceiling |
| `provider-failure-recovery.no-model-calls` | Provider failure recovery never calls a model |
| `provider-failure-recovery.fallback` | Provider fallback works correctly |
| `provider-failure-recovery.retry-backoff` | Retry backoff is bounded |

### 2.4 Backup restore tests

| Test | Description |
|---|---|
| `backup-restore.bounded` | Backup restore is bounded by deadlines |
| `backup-restore.deterministic` | Same state + same clock = same backup/restore |
| `backup-restore.journaled` | Backup restore is journaled |
| `backup-restore.never-stores-plaintext` | Backup restore never stores plaintext |
| `backup-restore.never-fabricates` | Backup restore never fabricates state |
| `backup-restore.verified` | Backup restore is verified |
| `backup-restore.encryption` | Backup encryption is verified |
| `backup-restore.validation` | Restored state is validated |

### 2.5 Degraded-mode honesty tests

| Test | Description |
|---|---|
| `degraded-mode.truthful` | Degraded mode is truthful |
| `degraded-mode.bounded` | Degraded mode is bounded by deadlines |
| `degraded-mode.deterministic` | Same state + same clock = same degraded mode |
| `degraded-mode.journaled` | Degraded mode is journaled |
| `degraded-mode.never-fabricates` | Degraded mode never fabricates capability |
| `degraded-mode.always-visible` | Degraded mode is always visible |
| `degraded-mode.level-transitions` | Degraded-mode level transitions are valid |

### 2.6 Repair workflow tests

| Test | Description |
|---|---|
| `repair-workflows.bounded` | Repair workflows are bounded by deadlines |
| `repair-workflows.deterministic` | Same state + same clock = same repair |
| `repair-workflows.journaled` | Repair workflows are journaled |
| `repair-workflows.authorized` | Repair workflows are authorized |
| `repair-workflows.verified` | Repair workflows are verified |
| `repair-workflows.never-self-modify` | Repair workflows never self-modify |
| `repair-workflows.unauthorized-refused` | Unauthorized repairs are refused |

### 2.7 Resilience state tests

| Test | Description |
|---|---|
| `state.computed` | Resilience state is computed from durable state |
| `state.explainable` | Every item carries reasoning |
| `state.honest-about-uncertainty` | Uncertainty is never hidden |
| `state.no-fabricated-confidence` | Confidence is never fabricated |
| `state.bounded` | Lists and strings are bounded |
| `state.deterministic` | Same inputs + same clock = same state |
| `state.no-model-calls` | Resilience state never calls a model |

---

## 3. Integration tests

### 3.1 Full resilience flow

| Test | Description |
|---|---|
| `integration.wake-to-recovery` | Wake → detect → recover → verify → continue |
| `integration.wake-to-repair` | Wake → detect → repair → verify → continue |
| `integration.wake-to-escalation` | Wake → ... → escalate → owner notified |
| `integration.wake-to-stop` | Wake → ... → STOP ALL → halt |
| `integration.multi-day-recovery` | Multi-day recovery continuation across wakes |
| `integration.backup-restore-flow` | Backup/restore flow |
| `integration.degraded-mode-flow` | Degraded-mode transition flow |
| `integration.interrupted-recovery-reconciliation` | Interrupted recovery reconciliation |
| `integration.provider-fallback-flow` | Provider fallback flow |
| `integration.self-modification-refusal-flow` | Self-modification refusal flow |

### 3.2 Authority preservation tests

| Test | Description |
|---|---|
| `authority.guard-not-bypassed` | Guard capability checks are never bypassed |
| `authority.governor-not-bypassed` | Governor cognition authorization is never bypassed |
| `authority.stop-all-respected` | STOP ALL immediately halts everything |
| `authority.budgets-respected` | Budget limits are never exceeded |
| `authority.approvals-respected` | Approval requirements are never skipped |
| `authority.no-self-approval` | Recovery cannot approve its own requests |
| `authority.no-grant-creation` | Recovery cannot create grants |
| `authority.no-capability-widening` | Recovery cannot widen capabilities |
| `authority.no-real-money-actions` | No real-money/economic actions are performed |
| `authority.no-spending-authority` | No spending authority is added |
| `authority.no-real-orders` | No real orders are placed |
| `authority.no-self-modification` | No trusted runtime code is self-modified |

---

## 4. Red-team tests

### 4.1 Authority escalation attempts

| Test | Description |
|---|---|
| `redteam.recovery-claims-capability` | Recovery claims a capability it does not hold → refused |
| `redteam.recovery-claims-authority` | Recovery claims authority it does not have → refused |
| `redteam.recovery-claims-owner` | Recovery claims to be the owner → refused |
| `redteam.recovery-claims-priority` | Recovery claims higher priority → refused |
| `redteam.recovery-claims-budget` | Recovery claims more budget → refused |
| `redteam.recovery-claims-approval` | Recovery claims approval it does not have → refused |
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
| `redteam.fabricate-recovery` | Attempt to fabricate recovery outcome → refused |
| `redteam.hide-degradation` | Attempt to hide degradation → detected |
| `redteam.fabricate-capability` | Attempt to fabricate capability → detected |

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
| `restart.recovery-survives` | Recovery state survives restarts |
| `restart.repair-survives` | Repair state survives restarts |
| `restart.backup-survives` | Backup state survives restarts |
| `restart.stop-all-survives` | STOP ALL survives restarts |
| `restart.no-silent-continuation` | No silent continuation occurs |
| `restart.no-fabricated-state` | No state is fabricated on restart |
| `restart.deterministic` | Same journal + same clock = same state |
| `restart.no-hidden-state` | No hidden state survives restart |

### 6.2 Interrupted recovery tests

| Test | Description |
|---|---|
| `restart.interrupted-recovery-reconciled` | Interrupted recoveries are reconciled |
| `restart.interrupted-recovery-not-resumed` | Interrupted recoveries are not silently resumed |
| `restart.interrupted-recovery-visible` | Interrupted recoveries are visible to owner |
| `restart.interrupted-recovery-journaled` | Interrupted recoveries are journaled |

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

- `createTestEnvironment()`: creates a test environment
- `createTestFailure()`: creates a test failure event
- `createTestRecovery()`: creates a test recovery record
- `createTestRepair()`: creates a test repair record
- `createTestWakeEvent()`: creates a test wake event
- `createTestResilienceState()`: creates a test resilience state

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
| Crash Recovery | 95% | 90% |
| Data Failure Recovery | 95% | 90% |
| Provider Failure Recovery | 95% | 90% |
| Backup Restore | 95% | 90% |
| Degraded-Mode Honesty | 95% | 90% |
| Repair Workflows | 95% | 90% |
| Resilience State | 95% | 90% |
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
