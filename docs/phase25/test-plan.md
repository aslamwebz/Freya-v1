# Phase 25 — Test Plan

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This test plan defines the testing strategy for Phase 25 Digital Senses &
Hands II. It covers unit tests, integration tests, red-team tests,
zero-idle-inference tests, and capability-specific tests.

All tests are deterministic: same inputs + same clock = same output. No test
relies on randomness, wall-clock time, or external services.

---

## 2. Unit tests

### 2.1 Capability registry tests

| Test | Description |
|---|---|
| `registry.lookup.valid` | Lookup a valid capability kind |
| `registry.lookup.invalid` | Lookup an invalid capability kind → null |
| `registry.validate-action.valid` | Validate a valid action |
| `registry.validate-action.invalid` | Validate an invalid action → false |
| `registry.validate-input.valid` | Validate valid input |
| `registry.validate-input.invalid` | Validate invalid input → false |
| `registry.get-risk.valid` | Get risk for a valid action |
| `registry.get-approval.valid` | Get approval requirement for a valid action |

### 2.2 Browser capability tests

| Test | Description |
|---|---|
| `browser.navigate.valid` | Navigate to a valid URL |
| `browser.navigate.invalid-url` | Navigate to an invalid URL → refused |
| `browser.navigate.timeout` | Navigate exceeds timeout → timed out |
| `browser.click.valid` | Click a valid element |
| `browser.click.invalid-selector` | Click with invalid selector → refused |
| `browser.type.valid` | Type valid text |
| `browser.type.invalid-selector` | Type with invalid selector → refused |
| `browser.read.valid` | Read valid content |
| `browser.read.invalid-selector` | Read with invalid selector → refused |
| `browser.form-fill.valid` | Fill a valid form field |
| `browser.form-fill.invalid-selector` | Fill with invalid selector → refused |
| `browser.element-click.valid` | Click a valid element |
| `browser.element-click.invalid-selector` | Click with invalid selector → refused |
| `browser.page-scroll.valid` | Scroll a valid amount |
| `browser.page-scroll.invalid-direction` | Scroll with invalid direction → refused |
| `browser.content-extract.valid` | Extract valid content |
| `browser.content-extract.invalid-selector` | Extract with invalid selector → refused |

### 2.3 Terminal capability tests

| Test | Description |
|---|---|
| `terminal.command-run.valid` | Run a valid command |
| `terminal.command-run.invalid-command` | Run an invalid command → refused |
| `terminal.command-run.timeout` | Run exceeds timeout → timed out |
| `terminal.command-execute.valid` | Execute a valid command with output capture |
| `terminal.command-execute.invalid-command` | Execute an invalid command → refused |
| `terminal.command-execute.output-truncated` | Output exceeds bound → truncated |
| `terminal.command-cancel.valid` | Cancel a valid command |
| `terminal.command-cancel.invalid-id` | Cancel with invalid id → refused |

### 2.4 Clipboard capability tests

| Test | Description |
|---|---|
| `clipboard.read.valid` | Read clipboard content |
| `clipboard.read.empty` | Read empty clipboard → completed |
| `clipboard.read.timeout` | Read exceeds timeout → timed out |
| `clipboard.write.valid` | Write valid content |
| `clipboard.write.invalid-content` | Write invalid content → refused |
| `clipboard.write.timeout` | Write exceeds timeout → timed out |

### 2.5 Download/upload capability tests

| Test | Description |
|---|---|
| `download.start.valid` | Start a valid download |
| `download.start.invalid-url` | Start with invalid URL → refused |
| `download.start.invalid-destination` | Start with invalid destination → refused |
| `download.start.timeout` | Start exceeds timeout → timed out |
| `download.cancel.valid` | Cancel a valid download |
| `download.cancel.invalid-id` | Cancel with invalid id → refused |
| `download.status.valid` | Check valid download status |
| `download.status.invalid-id` | Check with invalid id → refused |
| `upload.start.valid` | Start a valid upload |
| `upload.start.invalid-source` | Start with invalid source → refused |
| `upload.start.invalid-destination` | Start with invalid destination → refused |
| `upload.start.timeout` | Start exceeds timeout → timed out |
| `upload.cancel.valid` | Cancel a valid upload |
| `upload.cancel.invalid-id` | Cancel with invalid id → refused |
| `upload.status.valid` | Check valid upload status |
| `upload.status.invalid-id` | Check with invalid id → refused |

---

## 3. Integration tests

### 3.1 Full capability execution flow

| Test | Description |
|---|---|
| `integration.action-to-result` | Action → Observation → Verification → Result |
| `integration.action-refused` | Action → Refusal |
| `integration.action-timeout` | Action → Timeout |
| `integration.action-cancelled` | Action → Cancelled |
| `integration.multi-action` | Multiple actions in sequence |
| `integration.concurrent-actions` | Multiple actions concurrently |

### 3.2 Authority preservation tests

| Test | Description |
|---|---|
| `authority.guard-not-bypassed` | Guard capability checks are never bypassed |
| `authority.governor-not-bypassed` | Governor cognition authorization is never bypassed |
| `authority.stop-all-respected` | STOP ALL immediately halts everything |
| `authority.budgets-respected` | Budget limits are never exceeded |
| `authority.approvals-respected` | Approval requirements are never skipped |
| `authority.no-self-approval` | Capability cannot approve its own requests |
| `authority.no-grant-creation` | Capability cannot create grants |
| `authority.no-capability-widening` | Capability cannot widen capabilities |

---

## 4. Red-team tests

### 4.1 Authority escalation attempts

| Test | Description |
|---|---|
| `redteam.worker-claims-capability` | Worker claims a capability it does not hold → refused |
| `redteam.worker-claims-authority` | Worker claims authority it does not have → refused |
| `redteam.worker-claims-owner` | Worker claims to be the owner → refused |
| `redteam.worker-claims-budget` | Worker claims more budget → refused |
| `redteam.worker-claims-approval` | Worker claims approval it does not have → refused |
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

### 4.3 Capability-specific attacks

| Test | Description |
|---|---|
| `redteam.browser.unrestricted-navigation` | Attempt to navigate to unrestricted URL → refused |
| `redteam.browser.unrestricted-click` | Attempt to click unrestricted element → refused |
| `redteam.terminal.unrestricted-command` | Attempt to run unrestricted command → refused |
| `redteam.clipboard.unrestricted-read` | Attempt to read unrestricted clipboard → refused |
| `redteam.clipboard.unrestricted-write` | Attempt to write unrestricted clipboard → refused |
| `redteam.download.unrestricted-url` | Attempt to download from unrestricted URL → refused |
| `redteam.download.unrestricted-destination` | Attempt to download to unrestricted destination → refused |
| `redteam.upload.unrestricted-source` | Attempt to upload from unrestricted source → refused |
| `redteam.upload.unrestricted-destination` | Attempt to upload to unrestricted destination → refused |

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
| `restart.replay-journal` | Journal is replayed on restart |
| `restart.rebuild-capability-state` | Capability state is rebuilt from journal |
| `restart.reconcile-interrupted-actions` | Interrupted actions are reconciled |
| `restart.resume-or-terminate` | Capability resumes or terminates explicitly |
| `restart.deterministic` | Same journal + same clock = same state |
| `restart.no-hidden-state` | No hidden state survives restart |
| `restart.no-fabricated-state` | No state is fabricated on restart |

### 6.2 Interrupted action recovery

| Test | Description |
|---|---|
| `restart.interrupted-action-reconciled` | Interrupted actions are reconciled |
| `restart.interrupted-action-not-resumed` | Interrupted actions are not silently resumed |
| `restart.interrupted-action-visible` | Interrupted actions are visible to owner |
| `restart.interrupted-action-journaled` | Interrupted actions are journaled |

---

## 7. Test infrastructure

### 7.1 Test doubles

- `FakeClock`: deterministic clock for testing
- `FakeJournal`: in-memory journal for testing
- `FakeWorker`: fake worker for testing
- `FakeModelProvider`: fake model provider for testing
- `FakeGuard`: fake Guard for testing
- `FakeGovernor`: fake Governor for testing
- `FakeBrowser`: fake browser for testing
- `FakeTerminal`: fake terminal for testing
- `FakeClipboard`: fake clipboard for testing
- `FakeDownload`: fake download for testing
- `FakeUpload`: fake upload for testing

### 7.2 Test helpers

- `createTestActionRequest()`: creates a test action request
- `createTestResult()`: creates a test action result
- `createTestObservation()`: creates a test observation
- `createTestVerification()`: creates a test verification
- `createTestRefusal()`: creates a test refusal

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
| Capability Registry | 95% | 90% |
| Browser Capability | 95% | 90% |
| Terminal Capability | 95% | 90% |
| Clipboard Capability | 95% | 90% |
| Download Capability | 95% | 90% |
| Upload Capability | 95% | 90% |
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
