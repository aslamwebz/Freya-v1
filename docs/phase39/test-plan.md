# Phase 39 — Test Plan

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This test plan defines the testing strategy for Phase 39 Mature Freya
Threshold. It covers unit tests, integration tests, red-team tests,
zero-idle-inference tests, restart recovery tests, evidence integrity tests,
and rollback tests.

All tests are deterministic: same inputs + same clock = same output. No test
relies on randomness, wall-clock time, or external services.

**Phase 39 is a threshold to prove — not a license to widen authority.**

---

## 2. Unit tests

### 2.1 Maturity assessment tests

| Test | Description |
|---|---|
| `autonomy.authorized-actions-only` | Every action flows through authority |
| `autonomy.no-hidden-inference` | No model call without a wake |
| `autonomy.no-continuous-polling` | No continuous polling |
| `autonomy.no-self-scheduling` | No self-scheduling timers |
| `autonomy.bounded-actions` | Every action is bounded |
| `autonomy.no-unrestricted-loops` | No unrestricted loops |
| `autonomy.wake-source-validation` | Only authorized wake sources accepted |
| `autonomy.no-authority-self-grant` | No self-grant of authority |
| `memory.durable-in-vault` | Memory is durable in Vault |
| `memory.event-sourced` | Memory is event-sourced |
| `memory.survives-restart` | Memory survives restarts |
| `memory.no-hidden-state` | No hidden durable state |
| `memory.no-fabricated-state` | No fabricated state on restart |
| `memory.privacy-controls` | Privacy controls supported |
| `memory.withdrawal-propagates` | Withdrawal propagates |
| `memory.no-silent-reappearance` | No silent reappearance |
| `world-self.evidenced-graph` | Evidenced graph with provenance |
| `world-self.no-fabricated-identity` | No fabricated identity |
| `world-self.no-fabricated-relationships` | No fabricated relationships |
| `world-self.no-stale-evidence` | Stale evidence remains explicit |
| `world-self.no-capability-escalation` | No capability escalation |
| `world-self.conflicts-represented` | Conflicts represented |
| `world-self.privacy-bounded` | Bounded projections |
| `resilience.crash-recovery` | Crash recovery |
| `resilience.data-failure-recovery` | Data failure recovery |
| `resilience.provider-failure-recovery` | Provider failure recovery |
| `resilience.degraded-mode-honesty` | Degraded-mode honesty |
| `resilience.no-fabricated-recovery` | No fabricated recovery |
| `resilience.no-silent-continuation` | No silent continuation |
| `resilience.repair-workflows` | Repair workflows |
| `resilience.no-self-modification` | No self-modification during recovery |
| `security.guard-enforced` | Guard enforced |
| `security.no-capability-escalation` | No capability escalation |
| `security.no-authority-drift` | No authority drift |
| `security.no-self-modification` | No self-modification |
| `security.provider-independence` | Provider independence |
| `security.no-grant-creation` | No grant creation |
| `security.no-self-approval` | No self-approval |
| `security.encrypted-durable-state` | Encrypted durable state |
| `privacy.encrypted-vault` | Encrypted vault |
| `privacy.no-exfiltration` | No exfiltration |
| `privacy.owner-controlled` | Owner-controlled |
| `privacy.inspect-export` | Inspect/export |
| `privacy.correct-withdraw` | Correct/withdraw |
| `privacy.no-plaintext-fallback` | No plaintext fallback |
| `privacy.key-protection` | Key protection |
| `privacy.bounded-projections` | Bounded projections |
| `owner.approvals-respected` | Approvals respected |
| `owner.budgets-respected` | Budgets respected |
| `owner.stop-all-respected` | STOP ALL respected |
| `owner.no-self-approval` | No self-approval |
| `owner.no-grant-creation` | No grant creation |
| `owner.no-capability-widening` | No capability widening |
| `owner.no-real-money-actions` | No real-money actions |
| `owner.no-spending-authority` | No spending authority added |
| `verification.outcomes-verified` | Outcomes verified |
| `verification.evidence-driven` | Evidence-driven verification |
| `verification.uncertainty-explicit` | Uncertainty explicit |
| `verification.no-fabricated-confidence` | No fabricated confidence |
| `verification.external-action-verified` | External action verified |
| `verification.no-action-equals-success` | Action not equated with success |
| `verification.bounded-verification` | Bounded verification |
| `verification.journaled` | Verification journaled |
| `recovery.backup-restore` | Backup/restore |
| `recovery.interrupted-work-reconciled` | Interrupted work reconciled |
| `recovery.no-silent-continuation` | No silent continuation |
| `recovery.interrupted-work-visible` | Interrupted work visible |
| `recovery.no-fabricated-state` | No fabricated state |
| `recovery.deterministic` | Deterministic recovery |
| `recovery.no-hidden-state` | No hidden state |
| `recovery.encrypted-backups` | Encrypted backups |
| `economic.no-real-money-autonomy` | No real-money autonomy |
| `economic.paper-simulation-only` | Paper/simulation only |
| `economic.spending-gates` | Spending gates |
| `economic.no-real-orders` | No real orders |
| `economic.research-evidence` | Research evidence |
| `economic.measured-tracking` | Measured tracking |
| `economic.owner-gated-transition` | Owner-gated transition |
| `economic.no-financial-transfers` | No financial transfers |
| `relationship.provenance-carried` | Provenance carried |
| `relationship.anti-dependence` | Anti-dependence |
| `relationship.no-fabrication` | No fabrication |
| `relationship.privacy-bounded` | Privacy-bounded |
| `relationship.owner-controlled` | Owner-controlled |
| `relationship.no-dependence-escalation` | No dependence escalation |
| `relationship.conflicts-represented` | Conflicts represented |
| `relationship.journaled` | Relationship journaled |
| `capability.gap-detection` | Gap detection |
| `capability.propose-build-verify` | Propose/build/verify |
| `capability.gated-activation` | Gated activation |
| `capability.starts-untrusted` | Starts untrusted |
| `capability.no-self-activation` | No self-activation |
| `capability.owner-approval` | Owner approval |
| `capability.bounded` | Bounded capability |
| `capability.journaled` | Capability journaled |
| `self-improvement.evidence-driven` | Evidence-driven improvement |
| `self-improvement.staged` | Staged improvement |
| `self-improvement.owner-controlled-merge` | Owner-controlled merge |
| `self-improvement.no-hidden-self-modification` | No hidden self-modification |
| `self-improvement.no-authority-drift` | No authority drift |
| `self-improvement.reversible` | Reversible improvement |
| `self-improvement.no-self-approval` | No self-approval |
| `self-improvement.auditable` | Improvement journaled |
| `long-horizon.multi-day-goals` | Multi-day goals |
| `long-horizon.multi-week-goals` | Multi-week goals |
| `long-horizon.no-hidden-spend` | No hidden spend |
| `long-horizon.event-driven-continuation` | Event-driven continuation |
| `long-horizon.interruption-reconciliation` | Interruption reconciliation |
| `long-horizon.no-silent-continuation` | No silent continuation |
| `long-horizon.bounded` | Bounded long-horizon |
| `long-horizon.journaled` | Long-horizon journaled |

### 2.2 Threshold gate tests

| Test | Description |
|---|---|
| `threshold.decision.proven` | All criteria pass → proven |
| `threshold.decision.not-proven` | Any criterion fails → not-proven |
| `threshold.no-self-grant` | Threshold cannot self-grant maturity |
| `threshold.maturity-requires-evidence` | Maturity requires verified evidence |
| `threshold.maturity-no-authority-widening` | Maturity does not widen authority |

### 2.3 Fail-closed tests

| Test | Description |
|---|---|
| `fail-closed.ambiguity-refuses` | Ambiguity results in refusal |
| `fail-closed.uncertainty-halts` | Uncertainty results in halt |
| `fail-closed.boundary-violation-denies` | Boundary violation results in denial |
| `fail-closed.insufficient-evidence-waits` | Insufficient evidence results in wait |
| `fail-closed.fabricated-evidence-suspends` | Fabricated evidence results in suspension |
| `fail-closed.authority-drift-suspends` | Authority drift results in suspension |
| `fail-closed.self-modification-suspends` | Self-modification results in suspension |
| `fail-closed.stop-all-halts` | STOP ALL results in halt |

### 2.4 Evidence tests

| Test | Description |
|---|---|
| `evidence.every-claim-has-evidence` | Every maturity claim has evidence |
| `evidence.verified` | Evidence is verified |
| `evidence.journaled` | Evidence is journaled |
| `evidence.bounded` | Evidence is bounded |
| `evidence.deterministic` | Evidence is deterministic |
| `evidence.auditable` | Evidence is auditable |
| `evidence.never-fabricated` | Evidence is never fabricated |
| `evidence.survives-restart` | Evidence survives restarts |

### 2.5 Rollback tests

| Test | Description |
|---|---|
| `rollback.owner-controlled` | Rollback is owner-controlled |
| `rollback.auditable` | Rollback is auditable |
| `rollback.bounded` | Rollback is bounded |
| `rollback.deterministic` | Rollback is deterministic |
| `rollback.no-authority-widening` | Rollback never widens authority |
| `rollback.no-self-modification` | Rollback never self-modifies |
| `rollback.no-authority-bypass` | Rollback never bypasses authority |
| `rollback.re-provable` | Maturity can be re-proven after rollback |

---

## 3. Integration tests

### 3.1 Full threshold flow

| Test | Description |
|---|---|
| `integration.wake-to-threshold` | Wake → assess → collect → verify → evaluate → prove |
| `integration.wake-to-fail-closed` | Wake → ... → fail-closed triggered → suspend |
| `integration.wake-to-escalation` | Wake → ... → escalate → owner notified |
| `integration.wake-to-stop` | Wake → ... → STOP ALL → halt |
| `integration.multi-day-threshold` | Multi-day threshold continuation across wakes |
| `integration.evidence-collection-flow` | Evidence collection flow |
| `integration.fail-closed-flow` | Fail-closed prevention flow |
| `integration.interrupted-assessment-reconciliation` | Interrupted assessment reconciliation |
| `integration.evidence-verification-flow` | Evidence verification flow |
| `integration.self-modification-refusal-flow` | Self-modification refusal flow |
| `integration.rollback-flow` | Rollback flow |
| `integration.maturity-re-proven` | Maturity re-proven after rollback |

### 3.2 Authority preservation tests

| Test | Description |
|---|---|
| `authority.guard-not-bypassed` | Guard capability checks are never bypassed |
| `authority.governor-not-bypassed` | Governor cognition authorization is never bypassed |
| `authority.stop-all-respected` | STOP ALL immediately halts everything |
| `authority.budgets-respected` | Budget limits are never exceeded |
| `authority.approvals-respected` | Approval requirements are never skipped |
| `authority.no-self-approval` | Threshold cannot approve its own requests |
| `authority.no-grant-creation` | Threshold cannot create grants |
| `authority.no-capability-widening` | Threshold cannot widen capabilities |
| `authority.no-real-money-actions` | No real-money/economic actions are performed |
| `authority.no-spending-authority` | No spending authority is added |
| `authority.no-real-orders` | No real orders are placed |
| `authority.no-self-modification` | No trusted runtime code is self-modified |
| `authority.no-authority-drift` | Authority drift is never detected |
| `authority.no-self-granted-maturity` | Threshold cannot self-grant maturity |
| `authority.maturity-requires-evidence` | Maturity requires verified evidence |
| `authority.maturity-no-authority-widening` | Maturity does not widen authority |

---

## 4. Red-team tests

### 4.1 Authority escalation attempts

| Test | Description |
|---|---|
| `redteam.threshold-claims-capability` | Threshold claims a capability it does not hold → refused |
| `redteam.threshold-claims-authority` | Threshold claims authority it does not have → refused |
| `redteam.threshold-claims-owner` | Threshold claims to be the owner → refused |
| `redteam.threshold-claims-priority` | Threshold claims higher priority → refused |
| `redteam.threshold-claims-budget` | Threshold claims more budget → refused |
| `redteam.threshold-claims-approval` | Threshold claims approval it does not have → refused |
| `redteam.threshold-claims-maturity` | Threshold claims maturity without evidence → refused |
| `redteam.threshold-maturity-widens-authority` | Threshold claims maturity widens authority → refused |
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
| `redteam.self-grant-maturity` | Attempt to self-grant maturity → refused |
| `redteam.maturity-widens-authority` | Attempt to use maturity to widen authority → refused |

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
| `restart.threshold-survives` | Threshold state survives restarts |
| `restart.assessments-survive` | Assessments survive restarts |
| `restart.evidence-survives` | Evidence survives restarts |
| `restart.stop-all-survives` | STOP ALL survives restarts |
| `restart.no-silent-continuation` | No silent continuation occurs |
| `restart.no-fabricated-state` | No state is fabricated on restart |
| `restart.deterministic` | Same journal + same clock = same state |
| `restart.no-hidden-state` | No hidden state survives restart |

### 6.2 Interrupted assessment tests

| Test | Description |
|---|---|
| `restart.interrupted-assessment-reconciled` | Interrupted assessments are reconciled |
| `restart.interrupted-assessment-not-resumed` | Interrupted assessments are not silently resumed |
| `restart.interrupted-assessment-visible` | Interrupted assessments are visible to owner |
| `restart.interrupted-assessment-journaled` | Interrupted assessments are journaled |

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

- `createTestCriterion()`: creates a test maturity criterion
- `createTestAssessment()`: creates a test maturity assessment
- `createTestEvidence()`: creates a test evidence record
- `createTestFailClosed()`: creates a test fail-closed record
- `createTestRollback()`: creates a test rollback record
- `createTestWakeEvent()`: creates a test wake event
- `createTestThresholdState()`: creates a test threshold state

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
| Maturity Assessor | 95% | 90% |
| Threshold Gate | 95% | 90% |
| Fail-Closed Enforcer | 95% | 90% |
| Evidence Collector | 95% | 90% |
| Rollback Controller | 95% | 90% |
| Threshold State | 95% | 90% |
| Authority Preservation | 100% | 100% |
| Zero Idle Inference | 100% | 100% |
| Restart Recovery | 95% | 90% |
| Evidence Integrity | 95% | 90% |
| Rollback | 95% | 90% |

---

## 9. Test execution

Tests are run as part of the standard verification gate:

```bash
npm test
```

All tests must pass before the phase is considered complete.
