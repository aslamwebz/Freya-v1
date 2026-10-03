# Phase 25 — Clipboard Capability

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Phase 25 adds clipboard as a routed capability. Clipboard actions are
bounded, tested, and authority-preserving.

The core invariant:

> **Clipboard actions are bounded, tested, and authority-preserving. They do
> not widen authority.**

---

## 2. Clipboard actions

### 2.1 clipboard-read

Read bounded clipboard content.

**Input fields:** none

**Constraints:**
- Read content is bounded to 10,000 characters
- Read content is sanitised (control characters stripped)
- Action timeout: 5 seconds
- Risk: none
- Approval: not required

### 2.2 clipboard-write

Write bounded content to clipboard.

**Input fields:**
- `content` — content to write (bounded string)

**Constraints:**
- Content is bounded to 10,000 characters
- Content is sanitised (control characters stripped)
- Action timeout: 5 seconds
- Risk: routine
- Approval: not required

---

## 3. Clipboard action lifecycle

Every clipboard action follows the same lifecycle:

```
Action Request → Guard Check → STOP ALL Check → Budget Check → Approval Check → Execution → Observation → Verification → Result
```

### 3.1 Action Request

The action request is validated against the closed tables and code-owned
limits. An invalid request is refused with a closed code.

### 3.2 Guard Check

Guard evaluates the capability. If the caller does not hold the capability,
the action is refused.

### 3.3 STOP ALL Check

If STOP ALL is active, the action is refused.

### 3.4 Budget Check

If the budget is exhausted, the action is refused.

### 3.5 Approval Check

If approval is required and not granted, the action is refused.

### 3.6 Execution

The action is executed with a bounded timeout. The action produces zero or
more observations.

### 3.7 Observation

Each observation is a bounded record of what was observed. Observations are
never journalled and never projected.

### 3.8 Verification

A verification is requested against the action and its observations. The
verifier returns a verdict.

### 3.9 Result

The action result is recorded. The action is verified only when a
verification result with `status: 'passed'` exists.

---

## 4. Clipboard action constraints

### 4.1 Bounded content

Every clipboard action has bounded content. Content that exceeds the bound
is refused, not truncated.

### 4.2 Bounded timeouts

Every clipboard action has a bounded timeout. An action that exceeds the
timeout is timed out, not killed.

### 4.3 Sanitised content

All clipboard content is sanitised: control characters are stripped, and
content is bounded.

### 4.4 No persistent state

Clipboard actions do not create persistent state. They are ephemeral: they
produce observations and verification results, but they do not modify the
clipboard's persistent state.

### 4.5 No journalled content

Clipboard content is never journalled. It is ephemeral and exists only in
memory for the duration of the action.

### 4.6 No projected content

Clipboard content is never projected. It is ephemeral and exists only in
memory for the duration of the action.

---

## 5. Clipboard action testing

Every clipboard action is tested deterministically:

- Same inputs = same outputs
- No wall-clock dependency
- No external service dependency
- No model call dependency
- Repeatable and auditable

### 5.1 Test cases

| Test | Description |
|---|---|
| `clipboard.read.valid` | Read clipboard content |
| `clipboard.read.empty` | Read empty clipboard → completed |
| `clipboard.read.timeout` | Read exceeds timeout → timed out |
| `clipboard.write.valid` | Write valid content |
| `clipboard.write.invalid-content` | Write invalid content → refused |
| `clipboard.write.timeout` | Write exceeds timeout → timed out |

---

## 6. Clipboard action and authority

### 6.1 Guard

Clipboard actions are checked through Guard. A clipboard action cannot be
executed without Guard approval.

### 6.2 Governor

Clipboard actions do not require cognition. They are deterministic and do
not call models.

### 6.3 STOP ALL

If STOP ALL is active, all clipboard actions are refused.

### 6.4 Budgets

Clipboard actions are checked against budgets. A clipboard action cannot
exceed the remaining budget.

### 6.5 Approvals

Clipboard actions do not require approval. They are routine and do not
modify consequential state.

---

## 7. Test plan summary

See `docs/phase25/test-plan.md` for the full test plan.

---

## 8. Acceptance criteria summary

See `docs/phase25/acceptance-criteria.md` for full acceptance criteria.
