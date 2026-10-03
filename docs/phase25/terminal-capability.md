# Phase 25 — Terminal Capability Expansion

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Phase 25 expands the terminal capability with additional tested, bounded
actions. These actions are additive: they do not replace or modify the
existing terminal actions from Phase 10.

The core invariant:

> **Terminal actions are bounded, tested, and authority-preserving. They do
> not widen authority.**

---

## 2. New terminal actions

### 2.1 command-execute

Execute a bounded command with output capture.

**Input fields:**
- `command` — command to execute (bounded string)
- `maxOutputBytes` — maximum output capture in bytes (bounded integer)

**Constraints:**
- Command is bounded to 4,096 characters
- Command is sanitised (control characters stripped)
- maxOutputBytes is bounded to 64,000 bytes
- Action timeout: 60 seconds
- Risk: consequential
- Approval: required

### 2.2 command-cancel

Cancel a running command.

**Input fields:**
- `commandId` — id of the command to cancel (bounded string)

**Constraints:**
- commandId is bounded to 128 characters
- Action timeout: 5 seconds
- Risk: none
- Approval: not required

---

## 3. Existing terminal actions (from Phase 10)

### 3.1 command-run

Run a bounded command.

**Input fields:**
- `command` — command to run (bounded string)

**Constraints:**
- Command is bounded to 4,096 characters
- Command is sanitised (control characters stripped)
- Action timeout: 60 seconds
- Risk: consequential
- Approval: required

---

## 4. Terminal action lifecycle

Every terminal action follows the same lifecycle:

```
Action Request → Guard Check → STOP ALL Check → Budget Check → Approval Check → Execution → Observation → Verification → Result
```

### 4.1 Action Request

The action request is validated against the closed tables and code-owned
limits. An invalid request is refused with a closed code.

### 4.2 Guard Check

Guard evaluates the capability. If the caller does not hold the capability,
the action is refused.

### 4.3 STOP ALL Check

If STOP ALL is active, the action is refused.

### 4.4 Budget Check

If the budget is exhausted, the action is refused.

### 4.5 Approval Check

If approval is required and not granted, the action is refused.

### 4.6 Execution

The action is executed with a bounded timeout. The action produces zero or
more observations.

### 4.7 Observation

Each observation is a bounded record of what was observed. Observations are
never journalled and never projected.

### 4.8 Verification

A verification is requested against the action and its observations. The
verifier returns a verdict.

### 4.9 Result

The action result is recorded. The action is verified only when a
verification result with `status: 'passed'` exists.

---

## 5. Terminal action constraints

### 5.1 Bounded commands

Every terminal action has bounded commands. A command that exceeds the
bound is refused, not truncated.

### 5.2 Bounded timeouts

Every terminal action has a bounded timeout. An action that exceeds the
timeout is timed out, not killed.

### 5.3 Bounded output

Every terminal action has bounded output. An output that exceeds the bound
is truncated and marked as such.

### 5.4 Sanitised commands

All terminal commands are sanitised: control characters are stripped, and
commands are bounded.

### 5.5 No persistent state

Terminal actions do not create persistent state. They are ephemeral: they
produce observations and verification results, but they do not modify the
terminal's persistent state.

---

## 6. Terminal action testing

Every terminal action is tested deterministically:

- Same inputs = same outputs
- No wall-clock dependency
- No external service dependency
- No model call dependency
- Repeatable and auditable

### 6.1 Test cases

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

---

## 7. Terminal action and authority

### 7.1 Guard

Terminal actions are checked through Guard. A terminal action cannot be
executed without Guard approval.

### 7.2 Governor

Terminal actions do not require cognition. They are deterministic and do not
call models.

### 7.3 STOP ALL

If STOP ALL is active, all terminal actions are refused.

### 7.4 Budgets

Terminal actions are checked against budgets. A terminal action cannot
exceed the remaining budget.

### 7.5 Approvals

Terminal actions are marked as consequential and require approval. A
terminal action cannot proceed until the approval is granted.

---

## 8. Test plan summary

See `docs/phase25/test-plan.md` for the full test plan.

---

## 9. Acceptance criteria summary

See `docs/phase25/acceptance-criteria.md` for full acceptance criteria.
