# Phase 25 — Acceptance Criteria

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

These acceptance criteria define the conditions that must be met for Phase 25
to be considered complete. They are the gate between preparation and
implementation.

Each criterion is testable and auditable. A criterion is met when its test
passes and its invariant holds.

---

## 2. Functional criteria

### 2.1 Capability registry

| Criterion | Test |
|---|---|
| F1: Registry lookup valid capability | `registry.lookup.valid` |
| F2: Registry lookup invalid capability | `registry.lookup.invalid` |
| F3: Registry validate valid action | `registry.validate-action.valid` |
| F4: Registry validate invalid action | `registry.validate-action.invalid` |
| F5: Registry validate valid input | `registry.validate-input.valid` |
| F6: Registry validate invalid input | `registry.validate-input.invalid` |
| F7: Registry get risk | `registry.get-risk.valid` |
| F8: Registry get approval requirement | `registry.get-approval.valid` |

### 2.2 Browser capability

| Criterion | Test |
|---|---|
| F9: Browser navigate valid URL | `browser.navigate.valid` |
| F10: Browser navigate invalid URL | `browser.navigate.invalid-url` |
| F11: Browser click valid element | `browser.click.valid` |
| F12: Browser click invalid selector | `browser.click.invalid-selector` |
| F13: Browser type valid text | `browser.type.valid` |
| F14: Browser type invalid selector | `browser.type.invalid-selector` |
| F15: Browser read valid content | `browser.read.valid` |
| F16: Browser read invalid selector | `browser.read.invalid-selector` |
| F17: Browser form-fill valid field | `browser.form-fill.valid` |
| F18: Browser form-fill invalid selector | `browser.form-fill.invalid-selector` |
| F19: Browser element-click valid | `browser.element-click.valid` |
| F20: Browser element-click invalid selector | `browser.element-click.invalid-selector` |
| F21: Browser page-scroll valid | `browser.page-scroll.valid` |
| F22: Browser page-scroll invalid direction | `browser.page-scroll.invalid-direction` |
| F23: Browser content-extract valid | `browser.content-extract.valid` |
| F24: Browser content-extract invalid selector | `browser.content-extract.invalid-selector` |

### 2.3 Terminal capability

| Criterion | Test |
|---|---|
| F25: Terminal command-run valid | `terminal.command-run.valid` |
| F26: Terminal command-run invalid command | `terminal.command-run.invalid-command` |
| F27: Terminal command-execute valid | `terminal.command-execute.valid` |
| F28: Terminal command-execute invalid command | `terminal.command-execute.invalid-command` |
| F29: Terminal command-cancel valid | `terminal.command-cancel.valid` |
| F30: Terminal command-cancel invalid id | `terminal.command-cancel.invalid-id` |

### 2.4 Clipboard capability

| Criterion | Test |
|---|---|
| F31: Clipboard read valid | `clipboard.read.valid` |
| F32: Clipboard read empty | `clipboard.read.empty` |
| F33: Clipboard write valid | `clipboard.write.valid` |
| F34: Clipboard write invalid content | `clipboard.write.invalid-content` |

### 2.5 Download/upload capability

| Criterion | Test |
|---|---|
| F35: Download start valid | `download.start.valid` |
| F36: Download start invalid URL | `download.start.invalid-url` |
| F37: Download start invalid destination | `download.start.invalid-destination` |
| F38: Download cancel valid | `download.cancel.valid` |
| F39: Download cancel invalid id | `download.cancel.invalid-id` |
| F40: Download status valid | `download.status.valid` |
| F41: Download status invalid id | `download.status.invalid-id` |
| F42: Upload start valid | `upload.start.valid` |
| F43: Upload start invalid source | `upload.start.invalid-source` |
| F44: Upload start invalid destination | `upload.start.invalid-destination` |
| F45: Upload cancel valid | `upload.cancel.valid` |
| F46: Upload cancel invalid id | `upload.cancel.invalid-id` |
| F47: Upload status valid | `upload.status.valid` |
| F48: Upload status invalid id | `upload.status.invalid-id` |

---

## 3. Authority criteria

### 3.1 Guard

| Criterion | Test |
|---|---|
| A1: Guard capability checks are never bypassed | `authority.guard-not-bypassed` |
| A2: Workers cannot execute capabilities they do not hold | `redteam.worker-claims-capability` |

### 3.2 Governor

| Criterion | Test |
|---|---|
| A3: Governor cognition authorization is never bypassed | `authority.governor-not-bypassed` |
| A4: Workers cannot request cognition without a grant | `redteam.worker-claims-authority` |

### 3.3 STOP ALL

| Criterion | Test |
|---|---|
| A5: STOP ALL immediately halts everything | `authority.stop-all-respected` |
| A6: STOP ALL cannot be bypassed | `redteam.bypass-stop-all` |

### 3.4 Budgets

| Criterion | Test |
|---|---|
| A7: Budget limits are never exceeded | `authority.budgets-respected` |
| A8: Workers cannot claim more budget | `redteam.worker-claims-budget` |

### 3.5 Approvals

| Criterion | Test |
|---|---|
| A9: Approval requirements are never skipped | `authority.approvals-respected` |
| A10: Capability layer cannot approve its own requests | `authority.no-self-approval` |
| A11: Workers cannot claim approval | `redteam.worker-claims-approval` |

### 3.6 Grants

| Criterion | Test |
|---|---|
| A12: Capability layer cannot create grants | `authority.no-grant-creation` |
| A13: Only the owner may create grants | `redteam.create-grant` |

### 3.7 Capabilities

| Criterion | Test |
|---|---|
| A14: Capabilities are never widened beyond code-owned ceilings | `authority.no-capability-widening` |
| A15: Workers cannot widen their own capabilities | `redteam.widen-capability` |

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

## 5. Restart recovery criteria

| Criterion | Test |
|---|---|
| R1: Journal is replayed on restart | `restart.replay-journal` |
| R2: Capability state is rebuilt from journal | `restart.rebuild-capability-state` |
| R3: Interrupted actions are reconciled | `restart.reconcile-interrupted-actions` |
| R4: Capability resumes or terminates explicitly | `restart.resume-or-terminate` |
| R5: Restart is deterministic | `restart.deterministic` |
| R6: No hidden state survives restart | `restart.no-hidden-state` |
| R7: No state is fabricated on restart | `restart.no-fabricated-state` |
| R8: Interrupted actions are reconciled | `restart.interrupted-action-reconciled` |
| R9: Interrupted actions are not silently resumed | `restart.interrupted-action-not-resumed` |
| R10: Interrupted actions are visible to owner | `restart.interrupted-action-visible` |
| R11: Interrupted actions are journaled | `restart.interrupted-action-journaled` |

---

## 6. Red-team criteria

| Criterion | Test |
|---|---|
| RT1: Worker claims capability → refused | `redteam.worker-claims-capability` |
| RT2: Worker claims authority → refused | `redteam.worker-claims-authority` |
| RT3: Worker claims to be owner → refused | `redteam.worker-claims-owner` |
| RT4: Worker claims more budget → refused | `redteam.worker-claims-budget` |
| RT5: Worker claims approval → refused | `redteam.worker-claims-approval` |
| RT6: Bypass Guard → refused | `redteam.bypass-guard` |
| RT7: Bypass Governor → refused | `redteam.bypass-governor` |
| RT8: Bypass STOP ALL → refused | `redteam.bypass-stop-all` |
| RT9: Exceed budget → refused | `redteam.exceed-budget` |
| RT10: Skip approval → refused | `redteam.skip-approval` |
| RT11: Widen capability → refused | `redteam.widen-capability` |
| RT12: Create grant → refused | `redteam.create-grant` |
| RT13: Self-approve → refused | `redteam.self-approve` |
| RT14: Hidden inference → detected | `redteam.hidden-inference` |
| RT15: Continuous polling → detected | `redteam.continuous-polling` |
| RT16: Model output claims urgency → data | `redteam.model-claims-urgency` |
| RT17: Model output claims priority → data | `redteam.model-claims-priority` |
| RT18: Model output claims outcome → data | `redteam.model-claims-outcome` |
| RT19: Event claims importance → data | `redteam.event-claims-importance` |
| RT20: Event claims deadline → data | `redteam.event-claims-deadline` |
| RT21: Context claims authority → data | `redteam.context-claims-authority` |
| RT22: Browser unrestricted navigation → refused | `redteam.browser.unrestricted-navigation` |
| RT23: Browser unrestricted click → refused | `redteam.browser.unrestricted-click` |
| RT24: Terminal unrestricted command → refused | `redteam.terminal.unrestricted-command` |
| RT25: Clipboard unrestricted read → refused | `redteam.clipboard.unrestricted-read` |
| RT26: Clipboard unrestricted write → refused | `redteam.clipboard.unrestricted-write` |
| RT27: Download unrestricted URL → refused | `redteam.download.unrestricted-url` |
| RT28: Download unrestricted destination → refused | `redteam.download.unrestricted-destination` |
| RT29: Upload unrestricted source → refused | `redteam.upload.unrestricted-source` |
| RT30: Upload unrestricted destination → refused | `redteam.upload.unrestricted-destination` |

---

## 7. Integration criteria

| Criterion | Test |
|---|---|
| I1: Action → Observation → Verification → Result | `integration.action-to-result` |
| I2: Action → Refusal | `integration.action-refused` |
| I3: Action → Timeout | `integration.action-timeout` |
| I4: Action → Cancelled | `integration.action-cancelled` |
| I5: Multiple actions in sequence | `integration.multi-action` |
| I6: Multiple actions concurrently | `integration.concurrent-actions` |

---

## 8. Non-functional criteria

### 8.1 Determinism

- Same inputs + same clock = same output
- No randomness in any decision
- No wall-clock reads in any decision
- No external service calls in any decision

### 8.2 Boundedness

- Every list has a maximum length
- Every string has a maximum length
- Every number is in a closed range
- Every loop has a maximum iteration count
- Every timer has a maximum duration

### 8.3 Explainability

- Every decision carries reasoning
- Every refusal carries a closed reason code
- Every assumption is explicit
- Every uncertainty is surfaced
- Every blocked item carries a blocked reason

### 8.4 Auditability

- Every decision is journaled
- Every refusal is journaled
- Every assumption is journaled
- Every escalation is journaled
- Every red-team attempt is journaled

---

## 9. Acceptance gate

Phase 25 is accepted when:

1. All functional criteria (F1–F48) pass
2. All authority criteria (A1–A15) pass
3. All zero-idle-inference criteria (Z1–Z9) pass
4. All restart recovery criteria (R1–R11) pass
5. All red-team criteria (RT1–RT30) pass
6. All integration criteria (I1–I6) pass
7. All non-functional criteria pass
8. Full test suite passes
9. Typecheck passes
10. Lint passes
11. Red-team review passes
12. Owner approval
