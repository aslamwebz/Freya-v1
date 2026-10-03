# Phase 25 — Browser Capability Expansion

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Phase 25 expands the browser capability with additional tested, bounded
actions. These actions are additive: they do not replace or modify the
existing browser actions from Phase 10.

The core invariant:

> **Browser actions are bounded, tested, and authority-preserving. They do
> not widen authority.**

---

## 2. New browser actions

### 2.1 form-fill

Fill a form field with bounded input.

**Input fields:**
- `selector` — CSS selector for the form field (bounded string)
- `value` — value to fill (bounded string)

**Constraints:**
- Selector is bounded to 256 characters
- Value is bounded to 10,000 characters
- Value is sanitised (control characters stripped)
- Action timeout: 10 seconds
- Risk: routine
- Approval: not required

### 2.2 element-click

Click a bounded element.

**Input fields:**
- `selector` — CSS selector for the element (bounded string)

**Constraints:**
- Selector is bounded to 256 characters
- Action timeout: 10 seconds
- Risk: routine
- Approval: not required

### 2.3 page-scroll

Scroll a bounded amount.

**Input fields:**
- `direction` — scroll direction (up, down, left, right)
- `amount` — scroll amount in pixels (bounded integer)

**Constraints:**
- Direction is one of: up, down, left, right
- Amount is bounded to 10,000 pixels
- Action timeout: 5 seconds
- Risk: none
- Approval: not required

### 2.4 content-extract

Extract bounded content from a page.

**Input fields:**
- `selector` — CSS selector for the content (bounded string)

**Constraints:**
- Selector is bounded to 256 characters
- Extracted content is bounded to 64,000 characters
- Extracted content is sanitised (control characters stripped)
- Action timeout: 10 seconds
- Risk: none
- Approval: not required

---

## 3. Existing browser actions (from Phase 10)

### 3.1 navigate

Navigate to a bounded URL.

**Input fields:**
- `url` — URL to navigate to (bounded string)

**Constraints:**
- URL is bounded to 2,048 characters
- URL must be a valid HTTP or HTTPS URL
- Action timeout: 30 seconds
- Risk: routine
- Approval: not required

### 3.2 click

Click a bounded element.

**Input fields:**
- `selector` — CSS selector for the element (bounded string)

**Constraints:**
- Selector is bounded to 256 characters
- Action timeout: 10 seconds
- Risk: routine
- Approval: not required

### 3.3 type

Type bounded text.

**Input fields:**
- `selector` — CSS selector for the input (bounded string)
- `text` — text to type (bounded string)

**Constraints:**
- Selector is bounded to 256 characters
- Text is bounded to 10,000 characters
- Text is sanitised (control characters stripped)
- Action timeout: 10 seconds
- Risk: routine
- Approval: not required

### 3.4 read

Read bounded page content.

**Input fields:**
- `selector` — CSS selector for the content (bounded string)

**Constraints:**
- Selector is bounded to 256 characters
- Read content is bounded to 64,000 characters
- Read content is sanitised (control characters stripped)
- Action timeout: 10 seconds
- Risk: none
- Approval: not required

---

## 4. Browser action lifecycle

Every browser action follows the same lifecycle:

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

## 5. Browser action constraints

### 5.1 Bounded inputs

Every browser action has bounded inputs. An input that exceeds the bound is
refused, not truncated.

### 5.2 Bounded timeouts

Every browser action has a bounded timeout. An action that exceeds the
timeout is timed out, not killed.

### 5.3 Bounded outputs

Every browser action has bounded outputs. An output that exceeds the bound
is truncated and marked as such.

### 5.4 Sanitised content

All browser content is sanitised: control characters are stripped, and
content is bounded.

### 5.5 No persistent state

Browser actions do not create persistent state. They are ephemeral: they
produce observations and verification results, but they do not modify the
browser's persistent state.

---

## 6. Browser action testing

Every browser action is tested deterministically:

- Same inputs = same outputs
- No wall-clock dependency
- No external service dependency
- No model call dependency
- Repeatable and auditable

### 6.1 Test cases

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

---

## 7. Browser action and authority

### 7.1 Guard

Browser actions are checked through Guard. A browser action cannot be
executed without Guard approval.

### 7.2 Governor

Browser actions do not require cognition. They are deterministic and do not
call models.

### 7.3 STOP ALL

If STOP ALL is active, all browser actions are refused.

### 7.4 Budgets

Browser actions are checked against budgets. A browser action cannot exceed
the remaining budget.

### 7.5 Approvals

Browser actions that are marked as requiring approval cannot proceed until
the approval is granted.

---

## 8. Test plan summary

See `docs/phase25/test-plan.md` for the full test plan.

---

## 9. Acceptance criteria summary

See `docs/phase25/acceptance-criteria.md` for full acceptance criteria.
