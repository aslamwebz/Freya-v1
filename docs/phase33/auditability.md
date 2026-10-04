# Phase 33 — Auditability

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Auditability is a core property of the Autonomous Enterprise / Webzone subsystem.
Every decision, action, and refusal is journaled. Every enterprise boundary
enforcement is journaled. Every spending gate check is journaled. Every
external-action verification is journaled. Every rollback is journaled.

The audit trail is the proof that the enterprise subsystem operates within its
authority, boundaries, and spending limits.

---

## 2. Audit trail properties

### 2.1 Complete

The audit trail records:
- Every decision (with reasoning)
- Every action (with outcome)
- Every refusal (with closed reason code)
- Every boundary check (with result)
- Every spending gate check (with result)
- Every verification (with outcome)
- Every rollback (with outcome)
- Every escalation (with reason)
- Every red-team attempt (with refusal)

### 2.2 Durable

The audit trail is stored in the event journal. It survives restarts. It is
event-sourced — all changes are journaled.

### 2.3 Deterministic

The audit trail is deterministic. Same state + same clock = same audit trail.
This is testable and auditable.

### 2.4 Bounded

The audit trail is bounded:
- A maximum number of audit entries per operation
- A maximum length for each audit entry
- A maximum age for each audit entry

### 2.5 Explainable

Every audit entry carries:
- What was decided/acted/refused
- Why it was decided/acted/refused
- What alternatives were considered
- What is uncertain
- What is blocked

---

## 3. Audit entry structure

### 3.1 Required fields

Every audit entry has:
- `auditId`: a unique identifier
- `timestamp`: when the entry was created
- `category`: the category of the entry
- `action`: what was done
- `outcome`: what happened
- `reasoning`: why it was done
- `actor`: who/what triggered the entry
- `environmentId`: the parent environment

### 3.2 Optional fields

- `boundaryCheck`: the boundary check result (if applicable)
- `spendingGateCheck`: the spending gate check result (if applicable)
- `verification`: the verification outcome (if applicable)
- `rollback`: the rollback outcome (if applicable)

---

## 4. Audit categories

### 4.1 Decision audit

Records every decision made by the enterprise subsystem.

| Field | Description |
|---|---|
| `decisionId` | The decision's id |
| `decision` | The decision made |
| `reasoning` | Why the decision was made |
| `alternatives` | What alternatives were considered |
| `uncertainty` | What is uncertain |

### 4.2 Action audit

Records every action taken by the enterprise subsystem.

| Field | Description |
|---|---|
| `actionId` | The action's id |
| `action` | The action taken |
| `outcome` | What happened |
| `verification` | The verification outcome |

### 4.3 Refusal audit

Records every refusal made by the enterprise subsystem.

| Field | Description |
|---|---|
| `refusalId` | The refusal's id |
| `refusal` | The refusal made |
| `reason` | Why the action was refused |
| `reasonCode` | The closed reason code |

### 4.4 Boundary audit

Records every boundary check made by the enterprise subsystem.

| Field | Description |
|---|---|
| `boundaryCheckId` | The boundary check's id |
| `boundary` | The boundary checked |
| `result` | Whether the boundary held |
| `violation` | Whether the boundary was violated |

### 4.5 Spending audit

Records every spending gate check made by the enterprise subsystem.

| Field | Description |
|---|---|
| `spendingGateCheckId` | The spending gate check's id |
| `spendingLimit` | The spending limit checked |
| `result` | Whether the spending limit held |
| `exceeded` | Whether the spending limit was exceeded |

### 4.6 Verification audit

Records every verification made by the enterprise subsystem.

| Field | Description |
|---|---|
| `verificationId` | The verification's id |
| `verification` | The verification performed |
| `outcome` | The verification outcome |
| `reason` | Why the verification passed/failed |

### 4.7 Rollback audit

Records every rollback made by the enterprise subsystem.

| Field | Description |
|---|---|
| `rollbackId` | The rollback's id |
| `rollback` | The rollback performed |
| `outcome` | The rollback outcome |
| `reason` | Why the rollback was performed |

### 4.8 Escalation audit

Records every escalation made by the enterprise subsystem.

| Field | Description |
|---|---|
| `escalationId` | The escalation's id |
| `escalation` | The escalation performed |
| `reason` | Why the escalation was performed |
| `ownerNotified` | Whether the owner was notified |

### 4.9 Red-team audit

Records every red-team attempt detected by the enterprise subsystem.

| Field | Description |
|---|---|
| `redTeamId` | The red-team attempt's id |
| `attack` | The attack detected |
| `refusal` | The refusal made |
| `reason` | Why the attempt was refused |

---

## 5. Audit trail and authority

### 5.1 Audit trail does not grant authority

The audit trail does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements

### 5.2 Audit trail is always visible

The audit trail is always visible to the owner. It is never hidden, never
fabricated, and never silently modified.

---

## 6. Audit trail persistence

### 6.1 Durable storage

The audit trail is stored in the event journal. It survives restarts. It is
event-sourced — all changes are journaled.

### 6.2 Recovery

On restart:
1. Replay the journal
2. Rebuild the audit trail
3. Reconcile interrupted operations
4. Resume or terminate explicitly

---

## 7. Auditability invariants

These invariants must hold at all times:

1. **Audit trail is complete** — Every decision, action, and refusal is journaled.
2. **Audit trail is durable** — It survives restarts.
3. **Audit trail is deterministic** — Same state + same clock = same audit trail.
4. **Audit trail is bounded** — It has maximum lengths and ages.
5. **Audit trail is explainable** — Every entry carries reasoning.
6. **Audit trail does not grant authority** — Every action flows through existing authority.
7. **Audit trail is always visible** — It is never hidden.
8. **Audit trail is never fabricated** — It is always derived from actual events.
