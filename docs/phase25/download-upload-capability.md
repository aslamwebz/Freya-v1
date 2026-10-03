# Phase 25 — Download & Upload Capability

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Phase 25 adds download and upload as routed capabilities. Download and upload
actions are bounded, tested, and authority-preserving.

The core invariant:

> **Download and upload actions are bounded, tested, and authority-preserving.
> They do not widen authority.**

---

## 2. Download actions

### 2.1 download-start

Start a bounded download.

**Input fields:**
- `url` — URL to download from (bounded string)
- `destination` — destination path (bounded string)

**Constraints:**
- URL is bounded to 2,048 characters
- URL must be a valid HTTP or HTTPS URL
- Destination is bounded to 1,024 characters
- Download size is bounded to 100 MB
- Action timeout: 5 minutes
- Risk: consequential
- Approval: required

### 2.2 download-cancel

Cancel a running download.

**Input fields:**
- `downloadId` — id of the download to cancel (bounded string)

**Constraints:**
- downloadId is bounded to 128 characters
- Action timeout: 5 seconds
- Risk: none
- Approval: not required

### 2.3 download-status

Check download status.

**Input fields:**
- `downloadId` — id of the download to check (bounded string)

**Constraints:**
- downloadId is bounded to 128 characters
- Action timeout: 5 seconds
- Risk: none
- Approval: not required

---

## 3. Upload actions

### 3.1 upload-start

Start a bounded upload.

**Input fields:**
- `source` — source path (bounded string)
- `destination` — destination URL (bounded string)

**Constraints:**
- Source is bounded to 1,024 characters
- Destination is bounded to 2,048 characters
- Destination must be a valid HTTP or HTTPS URL
- Upload size is bounded to 100 MB
- Action timeout: 5 minutes
- Risk: consequential
- Approval: required

### 3.2 upload-cancel

Cancel a running upload.

**Input fields:**
- `uploadId` — id of the upload to cancel (bounded string)

**Constraints:**
- uploadId is bounded to 128 characters
- Action timeout: 5 seconds
- Risk: none
- Approval: not required

### 3.3 upload-status

Check upload status.

**Input fields:**
- `uploadId` — id of the upload to check (bounded string)

**Constraints:**
- uploadId is bounded to 128 characters
- Action timeout: 5 seconds
- Risk: none
- Approval: not required

---

## 4. Download/upload action lifecycle

Every download/upload action follows the same lifecycle:

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

## 5. Download/upload action constraints

### 5.1 Bounded URLs

Every download/upload action has bounded URLs. A URL that exceeds the bound
is refused, not truncated.

### 5.2 Bounded sizes

Every download/upload action has bounded sizes. A size that exceeds the
bound is refused, not truncated.

### 5.3 Bounded timeouts

Every download/upload action has a bounded timeout. An action that exceeds
the timeout is timed out, not killed.

### 5.4 Sanitised paths

All download/upload paths are sanitised: control characters are stripped,
and paths are bounded.

### 5.5 No persistent state

Download/upload actions do not create persistent state. They are ephemeral:
they produce observations and verification results, but they do not modify
the filesystem's persistent state.

### 5.6 No journalled content

Download/upload content is never journalled. It is ephemeral and exists
only in memory for the duration of the action.

### 5.7 No projected content

Download/upload content is never projected. It is ephemeral and exists only
in memory for the duration of the action.

---

## 6. Download/upload action testing

Every download/upload action is tested deterministically:

- Same inputs = same outputs
- No wall-clock dependency
- No external service dependency
- No model call dependency
- Repeatable and auditable

### 6.1 Test cases

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

## 7. Download/upload action and authority

### 7.1 Guard

Download/upload actions are checked through Guard. A download/upload action
cannot be executed without Guard approval.

### 7.2 Governor

Download/upload actions do not require cognition. They are deterministic and
do not call models.

### 7.3 STOP ALL

If STOP ALL is active, all download/upload actions are refused.

### 7.4 Budgets

Download/upload actions are checked against budgets. A download/upload action
cannot exceed the remaining budget.

### 7.5 Approvals

Download/upload actions are marked as consequential and require approval. A
download/upload action cannot proceed until the approval is granted.

---

## 8. Test plan summary

See `docs/phase25/test-plan.md` for the full test plan.

---

## 9. Acceptance criteria summary

See `docs/phase25/acceptance-criteria.md` for full acceptance criteria.
