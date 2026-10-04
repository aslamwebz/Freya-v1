# Phase 37 — Test Plan

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This test plan defines the testing strategy for Phase 37 Sovereign
Intelligence. It covers unit tests, integration tests, red-team tests,
zero-idle-inference tests, and restart recovery tests.

All tests are deterministic: same inputs + same clock = same output. No test
relies on randomness, wall-clock time, or external services.

---

## 2. Unit tests

### 2.1 Provider independence tests

| Test | Description |
|---|---|
| `provider-routing.bounded` | Provider routing is bounded by deadlines |
| `provider-routing.deterministic` | Same state + same clock = same routing |
| `provider-routing.journaled` | Provider routing is journaled |
| `provider-routing.fallback` | Provider fallback works correctly |
| `provider-routing.health-tracking` | Provider health tracking works |
| `provider-routing.never-adds-providers` | Provider independence never adds providers |
| `provider-routing.no-model-calls` | Provider independence never calls a model |

### 2.2 Offline/local reasoning tests

| Test | Description |
|---|---|
| `offline-reasoning.bounded` | Offline reasoning is bounded by deadlines |
| `offline-reasoning.deterministic` | Same state + same clock = same offline reasoning |
| `offline-reasoning.journaled` | Offline reasoning is journaled |
| `offline-reasoning.respects-authority` | Offline reasoning respects authority |
| `offline-reasoning.never-self-modifies` | Offline reasoning never self-modifies |
| `offline-reasoning.no-model-calls` | Offline reasoning never calls a model |

### 2.3 Portable encrypted data tests

| Test | Description |
|---|---|
| `portable-data.encrypted` | Portable data is encrypted |
| `portable-data.bounded` | Portable data is bounded by deadlines |
| `portable-data.deterministic` | Same data + same clock = same export/import |
| `portable-data.journaled` | Portable data is journaled |
| `portable-data.never-stores-plaintext` | Portable data never stores plaintext |
| `portable-data.verified` | Portable data is verified |
| `portable-data.never-self-modifies` | Portable data never self-modifies |

### 2.4 Sovereignty state tests

| Test | Description |
|---|---|
| `state.computed` | Sovereignty state is computed from durable state |
| `state.explainable` | Every item carries reasoning |
| `state.honest-about-uncertainty` | Uncertainty is never hidden |
| `state.no-fabricated-confidence` | Confidence is never fabricated |
| `state.bounded` | Lists and strings are bounded |
| `state.deterministic` | Same inputs + same clock = same state |
| `state.no-model-calls` | Sovereignty state never calls a model |

---

## 3. Integration tests

### 3.1 Full sovereignty flow

| Test | Description |
|---|---|
| `integration.wake-to-reasoning` | Wake → route → reason → verify → continue |
| `integration.wake-to-fallback` | Wake → ... → fallback → reason → verify → continue |
| `integration.wake-to-offline` | Wake → ... → offline → reason → verify → continue |
| `integration.wake-to-export` | Wake → ... → export → verify → continue |
| `integration.wake-to-import` | Wake → ... → import → verify → continue |
| `integration.wake-to-escalation` | Wake → ... → escalate → owner notified |
| `integration.wake-to-stop` | Wake → ... → STOP ALL → halt |
| `integration.multi-day-continuation` | Multi-day sovereignty continuation across wakes |
| `integration.provider-fallback-flow` | Provider fallback flow |
| `integration.offline-transition-flow` | Offline transition flow |

### 3.2 Authority preservation tests

| Test | Description |
|---|---|
| `authority.guard-not-bypassed` | Guard capability checks are never bypassed |
| `authority.governor-not-bypassed` | Governor cognition authorization is never bypassed |
| `authority.stop-all-respected` | STOP ALL immediately halts everything |
| `authority.budgets-respected` | Budget limits are never exceeded |
| `authority.approvals-respected` | Approval requirements are never skipped |
| `authority.no-self-approval` | Sovereignty cannot approve its own requests |
| `authority.no-grant-creation` | Sovereignty cannot create grants |
| `authority.no-capability-widening` | Sovereignty cannot widen capabilities |
| `authority.no-real-money-actions` | No real-money/economic actions are performed |
| `authority.no-spending-authority` | No spending authority is added |
| `authority.no-real-orders` | No real orders are placed |
| `authority.no-self-modification` | No trusted runtime code is self-modified |

---

## 4. Red-team tests

### 4.1 Authority escalation attempts

| Test | Description |
|---|---|
| `redteam.sovereignty-claims-capability` | Sovereignty claims a capability it does not hold → refused |
| `redteam.sovereignty-claims-authority` | Sovereignty claims authority it does not have → refused |
| `redteam.sovereignty-claims-owner` | Sovereignty claims to be the owner → refused |
| `redteam.sovereignty-claims-priority` | Sovereignty claims higher priority → refused |
| `redteam.sovereignty-claims-budget` | Sovereignty claims more budget → refused |
| `redteam.sovereignty-claims-approval` | Sovereignty claims approval it does not have → refused |
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
| `redteam.add-provider` | Attempt to add new provider → refused |
| `redteam.store-plaintext` | Attempt to store plaintext data → refused |
| `redteam.fabricate-integrity` | Attempt to fabricate data integrity → refused |

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
| `restart.sovereignty-survives` | Sovereignty state survives restarts |
| `restart.provider-state-survives` | Provider state survives restarts |
| `restart.offline-state-survives` | Offline state survives restarts |
| `restart.stop-all-survives` | STOP ALL survives restarts |
| `restart.no-silent-continuation` | No silent continuation occurs |
| `restart.no-fabricated-state` | No state is fabricated on restart |
| `restart.deterministic` | Same journal + same clock = same state |
| `restart.no-hidden-state` | No hidden state survives restart |

### 6.2 Interrupted sovereignty tests

| Test | Description |
|---|---|
| `restart.interrupted-sovereignty-reconciled` | Interrupted sovereignty is reconciled |
| `restart.interrupted-sovereignty-not-resumed` | Interrupted sovereignty is not silently resumed |
| `restart.interrupted-sovereignty-visible` | Interrupted sovereignty is visible to owner |
| `restart.interrupted-sovereignty-journaled` | Interrupted sovereignty is journaled |

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

- `createTestProvider()`: creates a test provider
- `createTestOfflineSession()`: creates a test offline session
- `createTestPortableData()`: creates a test portable data record
- `createTestWakeEvent()`: creates a test wake event
- `createTestSovereigntyState()`: creates a test sovereignty state

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
| Provider Independence | 95% | 90% |
| Offline/Local Reasoning | 95% | 90% |
| Portable Encrypted Data | 95% | 90% |
| Sovereignty State | 95% | 90% |
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
