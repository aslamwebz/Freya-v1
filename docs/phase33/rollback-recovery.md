# Phase 33 — Rollback and Recovery

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Rollback and recovery is the bounded, explicit process of rolling back
 reversible actions and recovering from failed actions. No irreversible action
can be rolled back. Rollback is bounded, deterministic, and journaled.

---

## 2. Rollback process

### 2.1 Steps

1. **Identify** — identify the action to roll back
2. **Assess** — assess whether the action is reversible
3. **Authorize** — request owner approval for rollback (if consequential)
4. **Execute** — execute the rollback within authority
5. **Verify** — verify the rollback outcome
6. **Record** — record the rollback outcome

### 2.2 Constraints

- Rollback never fabricates certainty
- Rollback always surfaces uncertainty
- Rollback never exceeds authority
- Rollback always respects STOP ALL
- Rollback never performs real-money actions
- Rollback never rolls back irreversible actions

---

## 3. Rollback outcomes

### 3.1 Success

The rollback was successful. The action was reversed.

### 3.2 Partial

The rollback was partially successful. Some aspects of the action were reversed.

### 3.3 Failed

The rollback failed. The action was not reversed.

### 3.4 Not-reversible

The action is not reversible. The rollback was refused.

---

## 4. Rollback structure

### 4.1 Required fields

Every rollback has:
- `rollbackId`: a unique identifier
- `actionId`: the action being rolled back
- `environmentId`: the parent environment
- `outcome`: success, partial, failed, or not-reversible
- `reason`: why the rollback was performed
- `rolledBackAt`: when the rollback was performed

### 4.2 Optional fields

- `verificationId`: the verification record for this rollback
- `partialDetails`: details of what was partially reversed

---

## 5. Reversibility assessment

### 5.1 Reversible actions

An action is reversible if:
- It can be undone without significant cost
- It does not cross an enterprise boundary
- It does not exceed a spending limit
- It does not perform a real-money action

### 5.2 Irreversible actions

An action is irreversible if:
- It cannot be undone without significant cost
- It crosses an enterprise boundary
- It exceeds a spending limit
- It performs a real-money action

### 5.3 Assessment properties

- Reversibility is assessed by code — not by the model
- Reversibility is deterministic — same state + same action = same assessment
- Reversibility is journaled — every assessment is durable
- Reversibility is never fabricated — it is always derived from the action

---

## 6. Rollback and authority

### 6.1 Rollback does not grant authority

Rollback does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Perform real-money actions

### 6.2 Rollback influences recovery only

Rollback determines whether an action can be reversed. It does not change what
the subsystem is allowed to do.

---

## 7. Rollback persistence

### 7.1 Durable storage

Rollbacks are stored in Vault. They survive restarts. They are event-sourced —
all changes are journaled.

### 7.2 Recovery

On restart:
1. Replay the journal
2. Rebuild rollback state
3. Reconcile interrupted rollbacks
4. Resume or terminate explicitly

---

## 8. Rollback limits

### 8.1 Code-owned ceilings

| Limit | Value |
|---|---|
| Max rollback attempts | 3 |
| Max rollback duration | 24 hours |
| Max rollbacks per environment | 32 |
| Max rollbacks per action | 1 |

### 8.2 Enforcement

These limits are enforced by code. They cannot be widened at runtime. They
cannot be overridden by a model response.

---

## 9. Rollback invariants

These invariants must hold at all times:

1. **Rollback is bounded** — Every rollback has a duration limit.
2. **Rollback is deterministic** — Same state + same clock = same result.
3. **Rollback is journaled** — Every rollback is durable.
4. **Rollback does not grant authority** — Every action flows through existing authority.
5. **Rollback never rolls back irreversible actions** — Irreversible actions cannot be rolled back.
6. **Rollback never fabricates outcomes** — Outcomes are always derived from evidence.
7. **Rollback respects boundaries** — No rollback crosses an enterprise boundary.
8. **Rollback respects spending limits** — No rollback exceeds a spending limit.
