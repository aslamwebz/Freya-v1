# Phase 25 — Architecture Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Digital Senses & Hands II expands the set of tested, bounded capabilities
available to Freya. It adds clipboard, download, and upload as routed
capabilities, and expands the browser and terminal capabilities with additional
tested, bounded actions.

The core invariant:

> **Hands are bounded tools, not unrestricted computer control. Capability
> expansion does not widen authority.**

Every new capability flows through the same authority paths as every existing
capability. No new authority is created.

---

## 2. Design principles

### 2.1 Bounded everywhere

Every capability action has:
- A maximum input size
- A maximum timeout
- A maximum number of observations
- A maximum number of verifications
- A closed set of supported actions
- A closed set of supported input fields

### 2.2 Authority-preserving

Before any capability action is executed:
1. Guard capability check passes
2. Governor cognition authorization is available (if cognition is needed)
3. STOP ALL is not active
4. Budget remaining is sufficient
5. Approval requirements are met (or the action is pre-approved)

No component can bypass any of these.

### 2.3 Deterministic testing

Every capability action is tested deterministically:
- Same inputs = same outputs
- No wall-clock dependency
- No external service dependency
- No model call dependency
- Repeatable and auditable

### 2.4 Explainable

Every capability action carries:
- What was asked for (action request)
- What happened (action result)
- What was observed (observation)
- Whether it worked (verification result)
- Why it was refused (refusal code)

### 2.5 Event-sourced

All capability state is derived from the event journal. On restart:
1. Replay the journal
2. Rebuild capability state
3. Reconcile interrupted actions
4. Resume or terminate explicitly

---

## 3. Components

### 3.1 CapabilityRegistry (new, Phase 25)

Maintains the closed set of capability kinds and their supported actions.

**Responsibilities:**
- Register capability kinds
- Register supported actions per capability kind
- Register supported input fields per action
- Register bounded timeouts per action
- Register bounded input sizes per action

**Does NOT:**
- Execute actions
- Bypass Guard
- Create authority

### 3.2 CapabilityTestingFramework (new, Phase 25)

Deterministic, repeatable tests for every capability action.

**Responsibilities:**
- Test every capability action
- Verify bounded inputs
- Verify bounded timeouts
- Verify refusal codes
- Verify authority preservation

**Does NOT:**
- Use wall-clock time
- Use external services
- Use model calls
- Test on production systems

### 3.3 BrowserCapability (expanded, Phase 25)

Additional tested, bounded browser actions.

**New actions:**
- `form-fill` — fill a form field with bounded input
- `element-click` — click a bounded element
- `page-scroll` — scroll a bounded amount
- `content-extract` — extract bounded content from a page

**Existing actions (from Phase 10):**
- `navigate` — navigate to a bounded URL
- `click` — click a bounded element
- `type` — type bounded text
- `read` — read bounded page content

### 3.4 TerminalCapability (expanded, Phase 25)

Additional tested, bounded terminal actions.

**New actions:**
- `command-execute` — execute a bounded command with output capture
- `command-cancel` — cancel a running command

**Existing actions (from Phase 10):**
- `command-run` — run a bounded command

### 3.5 ClipboardCapability (new, Phase 25)

Bounded clipboard read/write.

**Actions:**
- `clipboard-read` — read bounded clipboard content
- `clipboard-write` — write bounded content to clipboard

**Constraints:**
- Clipboard content is bounded
- Clipboard content is never journalled
- Clipboard content is never projected
- Clipboard access requires Guard capability check

### 3.6 DownloadCapability (new, Phase 25)

Bounded file download.

**Actions:**
- `download-start` — start a bounded download
- `download-cancel` — cancel a running download
- `download-status` — check download status

**Constraints:**
- Download URL is bounded
- Download size is bounded
- Download destination is bounded
- Download requires Guard capability check
- Download requires approval for consequential downloads

### 3.7 UploadCapability (new, Phase 25)

Bounded file upload.

**Actions:**
- `upload-start` — start a bounded upload
- `upload-cancel` — cancel a running upload
- `upload-status` — check upload status

**Constraints:**
- Upload source is bounded
- Upload size is bounded
- Upload destination is bounded
- Upload requires Guard capability check
- Upload requires approval for consequential uploads

---

## 4. Data flow

```
Action Request
    │
    ▼
CapabilityRegistry.lookup(capabilityId)
    │
    ├─ unknown → REFUSE (capability_unknown)
    │
    ▼ known
Guard.evaluate(capabilityId, scope)
    │
    ├─ deny → REFUSE (capability_unauthorized)
    │
    ▼ allow
STOP ALL check
    │
    ├─ active → REFUSE (stop_all)
    │
    ▼ not active
Budget check
    │
    ├─ exhausted → REFUSE (budget_exceeded)
    │
    ▼ sufficient
Approval check
    │
    ├─ required → REFUSE (approval_required)
    │
    ▼ not required or approved
Action Execution
    │
    ├─ running → Observation → Verification
    │
    ▼
Action Result
```

---

## 5. Integration with existing subsystems

### 5.1 Guard

The capability registry checks capabilities through Guard. It does not bypass
Guard. A capability cannot be executed without Guard approval.

### 5.2 Governor

The capability registry requests cognition through Governor. It does not
bypass Governor. A capability cannot request cognition without a grant.

### 5.3 STOP ALL

The capability registry checks STOP ALL before every action. If STOP ALL is
active, all actions are refused.

### 5.4 Budgets

The capability registry checks budgets before every action. An action cannot
exceed the remaining budget.

### 5.5 Approvals

The capability registry checks approval requirements before every action. An
action that requires approval cannot proceed until the approval is granted.

### 5.6 EventFabric

The capability registry appends events through EventFabric.append(). It does
not create a parallel store.

---

## 6. Boundaries

### 6.1 What Phase 25 owns

- Capability registry
- Capability testing framework
- Browser capability expansion
- Terminal capability expansion
- Clipboard capability
- Download capability
- Upload capability

### 6.2 What Phase 25 does NOT own

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)

---

## 7. Failure modes

| Failure | Handling |
|---|---|
| Capability unknown | Refused, journaled |
| Capability deferred | Refused, journaled |
| Capability unauthorized | Refused, journaled |
| STOP ALL active | Refused, journaled |
| Budget exhausted | Refused, journaled |
| Approval required | Refused, journaled |
| Action timeout | Timed out, journaled |
| Action failed | Failed, journaled |
| Verification failed | Failed, journaled |
| Restart during action | Reconciled, journaled |
