# Phase 25 — Capability Registry Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

The capability registry maintains the closed set of capability kinds and their
supported actions. It is the single source of truth for what capabilities
exist and what actions they support.

The registry is deterministic: same inputs = same outputs. It does not
execute actions, does not bypass Guard, and does not create authority.

---

## 2. Design principles

### 2.1 Closed set

The set of capability kinds is closed. A new capability kind requires a
PLAN.md update and a new registration in the registry.

### 2.2 Bounded actions

Every action has:
- A closed set of supported input fields
- A bounded timeout
- A bounded input size
- A risk level (none, routine, consequential)
- An approval requirement flag

### 2.3 Deterministic

The registry is a pure data structure. It does not read the clock, does not
perform I/O, and does not call models.

### 2.4 Authority-preserving

The registry does not execute actions. It only registers them. Execution
flows through Guard, Governor, STOP ALL, approvals and budgets.

---

## 3. Capability kinds

### 3.1 Browser

**Actions:**
- `navigate` — navigate to a bounded URL
- `click` — click a bounded element
- `type` — type bounded text
- `read` — read bounded page content
- `form-fill` — fill a form field with bounded input
- `element-click` — click a bounded element
- `page-scroll` — scroll a bounded amount
- `content-extract` — extract bounded content from a page

**Risk:** routine
**Approval:** not required for read-only actions; required for write actions

### 3.2 Terminal

**Actions:**
- `command-run` — run a bounded command
- `command-execute` — execute a bounded command with output capture
- `command-cancel` — cancel a running command

**Risk:** consequential
**Approval:** required

### 3.3 Clipboard

**Actions:**
- `clipboard-read` — read bounded clipboard content
- `clipboard-write` — write bounded content to clipboard

**Risk:** routine
**Approval:** not required for read; required for write

### 3.4 Download

**Actions:**
- `download-start` — start a bounded download
- `download-cancel` — cancel a running download
- `download-status` — check download status

**Risk:** consequential
**Approval:** required

### 3.5 Upload

**Actions:**
- `upload-start` — start a bounded upload
- `upload-cancel` — cancel a running upload
- `upload-status` — check upload status

**Risk:** consequential
**Approval:** required

### 3.6 Desktop (existing, not expanded)

**Actions:** none new in Phase 25

### 3.7 File (existing, not expanded)

**Actions:** none new in Phase 25

### 3.8 Shell (existing, not expanded)

**Actions:** none new in Phase 25

### 3.9 Network (existing, not expanded)

**Actions:** none new in Phase 25

---

## 4. Action registration

### 4.1 Browser actions

| Action | Input Fields | Timeout | Risk | Approval |
|---|---|---|---|---|
| `navigate` | url | 30s | routine | no |
| `click` | selector | 10s | routine | no |
| `type` | selector, text | 10s | routine | no |
| `read` | selector | 10s | none | no |
| `form-fill` | selector, value | 10s | routine | no |
| `element-click` | selector | 10s | routine | no |
| `page-scroll` | direction, amount | 5s | none | no |
| `content-extract` | selector | 10s | none | no |

### 4.2 Terminal actions

| Action | Input Fields | Timeout | Risk | Approval |
|---|---|---|---|---|
| `command-run` | command | 60s | consequential | yes |
| `command-execute` | command, maxOutputBytes | 60s | consequential | yes |
| `command-cancel` | commandId | 5s | none | no |

### 4.3 Clipboard actions

| Action | Input Fields | Timeout | Risk | Approval |
|---|---|---|---|---|
| `clipboard-read` | — | 5s | none | no |
| `clipboard-write` | content | 5s | routine | no |

### 4.4 Download actions

| Action | Input Fields | Timeout | Risk | Approval |
|---|---|---|---|---|
| `download-start` | url, destination | 5m | consequential | yes |
| `download-cancel` | downloadId | 5s | none | no |
| `download-status` | downloadId | 5s | none | no |

### 4.5 Upload actions

| Action | Input Fields | Timeout | Risk | Approval |
|---|---|---|---|---|
| `upload-start` | source, destination | 5m | consequential | yes |
| `upload-cancel` | uploadId | 5s | none | no |
| `upload-status` | uploadId | 5s | none | no |

---

## 5. Registry operations

### 5.1 Lookup

Given a capability kind, return its registration. If the kind is not in the
registry, return null.

### 5.2 Validate action

Given a capability kind and an action name, return whether the action is
supported. If the action is not supported, return false.

### 5.3 Validate input

Given a capability kind, an action name, and an input object, return whether
the input is valid. The input must:
- Have exactly the expected keys
- Have values of the correct type
- Be within the bounded size

### 5.4 Get risk

Given a capability kind and an action name, return the risk level.

### 5.5 Get approval requirement

Given a capability kind and an action name, return whether approval is
required.

---

## 6. Registry and authority

### 6.1 The registry does not grant authority

A capability registration is data, not authority. Registering a capability
does not mean the capability can be executed. Execution flows through Guard,
Governor, STOP ALL, approvals and budgets.

### 6.2 The registry does not bypass Guard

The registry does not execute actions. It only registers them. Guard
evaluates every action before it is executed.

### 6.3 The registry does not create new capabilities

A new capability kind requires a PLAN.md update and a new registration. The
registry does not create new capabilities at runtime.

---

## 7. Test plan summary

See `docs/phase25/test-plan.md` for the full test plan.

Key test categories:
1. Unit tests — registry lookup, validation, risk, approval
2. Integration tests — full capability execution flow
3. Red-team tests — authority escalation attempts
4. Zero-idle-inference tests — no model call without wake
5. Capability-specific tests — browser, terminal, clipboard, download, upload

---

## 8. Acceptance criteria summary

See `docs/phase25/acceptance-criteria.md` for full acceptance criteria.

Key criteria:
1. No continuous polling or hidden reasoning
2. Every wake is from an authorized source
3. Every cognition is gated by Governor
4. Every action is bounded and verifiable
5. STOP ALL immediately halts everything
6. Restart recovery is deterministic
7. Zero idle inference is proven
8. No authority escalation from any input
9. Every capability action is tested
10. No unrestricted computer control
