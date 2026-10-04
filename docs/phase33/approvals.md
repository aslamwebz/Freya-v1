# Phase 33 — Approvals

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Approvals are the owner's explicit authorization for consequential enterprise
actions. No consequential action is performed without owner approval. Approvals
are durable, auditable, and cannot be bypassed.

---

## 2. Approval types

### 2.1 Action approval

Required for consequential enterprise actions.

**Properties:**
- Explicit — no implicit approval
- Durable — stored in the journal
- Auditable — every approval is journaled
- Bounded — at most 32 pending approvals per environment
- Revocable — the owner can revoke an approval

### 2.2 Spending approval

Required for actions that exceed spending limits.

**Properties:**
- Explicit — no implicit approval
- Durable — stored in the journal
- Auditable — every approval is journaled
- Bounded — at most 16 pending spending approvals per environment
- Revocable — the owner can revoke an approval

### 2.3 Boundary approval

Required for actions that cross enterprise boundaries.

**Properties:**
- Explicit — no implicit approval
- Durable — stored in the journal
- Auditable — every approval is journaled
- Bounded — at most 8 pending boundary approvals per environment
- Revocable — the owner can revoke an approval

---

## 3. Approval lifecycle

### 3.1 States

| State | Description | Terminal? |
|---|---|---|
| `pending` | Approval is awaiting owner decision | No |
| `granted` | Approval was granted | Yes |
| `denied` | Approval was denied | Yes |
| `revoked` | Approval was revoked | Yes |
| `expired` | Approval expired | Yes |

### 3.2 Transitions

| From | To | Condition |
|---|---|---|
| `pending` | `granted` | Owner grants approval |
| `pending` | `denied` | Owner denies approval |
| `pending` | `expired` | Approval deadline expires |
| `granted` | `revoked` | Owner revokes approval |
| `denied` | — | Terminal |
| `revoked` | — | Terminal |
| `expired` | — | Terminal |

---

## 4. Approval structure

### 4.1 Required fields

Every approval has:
- `approvalId`: a unique identifier
- `environmentId`: the parent environment
- `kind`: action, spending, or boundary
- `state`: one of the closed set of approval states
- `request`: what is being requested
- `reasoning`: why the approval is needed
- `requestedAt`: when the approval was requested
- `decidedAt`: when the owner decided (null if pending)
- `expiresAt`: when the approval expires

### 4.2 Optional fields

- `decidedBy`: who decided the approval
- `revokedAt`: when the approval was revoked
- `revokeReason`: why the approval was revoked

---

## 5. Approval enforcement

### 5.1 Enforcement points

Approvals are enforced at:
1. **Before every consequential action** — the approval is checked before the action starts
2. **Before every spending action** — the spending approval is checked
3. **Before every boundary-crossing action** — the boundary approval is checked

### 5.2 Enforcement properties

- Approvals are enforced by code — not by the model
- Approvals are deterministic — same state + same approval = same result
- Approvals are journaled — every approval check is durable
- Approvals are never skipped — no action bypasses an approval check

### 5.3 Approval violation handling

When an approval is required but not present:
1. The action is refused
2. The refusal is journaled with a closed reason code
3. The owner is notified
4. No state change occurs
5. The approval is not fabricated

---

## 6. Approval and authority

### 6.1 Approvals do not grant authority

An approval does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip other approval requirements
- Perform real-money actions

### 6.2 Approvals gate actions

An approval gates whether a consequential action can proceed. It does not
change what the subsystem is allowed to do — it gates whether a specific
action can proceed.

---

## 7. Approval persistence

### 7.1 Durable storage

Approvals are stored in Vault. They survive restarts. They are event-sourced —
all changes are journaled.

### 7.2 Recovery

On restart:
1. Replay the journal
2. Rebuild approval state
3. Reconcile pending approvals
4. Resume or terminate explicitly

---

## 8. Approval invariants

These invariants must hold at all times:

1. **Approvals are explicit** — No implicit approval.
2. **Approvals are durable** — They survive restarts.
3. **Approvals are auditable** — Every approval is journaled.
4. **Approvals are bounded** — They have maximum counts and expiration times.
5. **Approvals are enforced** — Every consequential action is checked.
6. **Approvals do not grant authority** — Every action flows through existing authority.
7. **Approvals are never skipped** — No action bypasses an approval check.
8. **Approvals are never fabricated** — They are always derived from owner decisions.
