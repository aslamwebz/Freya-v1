# Phase 33 — External-Action Verification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

External-action verification is the process of verifying external actions before
they are considered complete. No external action is considered complete without
verification. Verification is bounded, deterministic, and journaled.

---

## 2. Verification process

### 2.1 Steps

1. **Execute** — execute the external action within authority
2. **Observe** — observe the action outcome
3. **Verify** — verify the outcome deterministically
4. **Record** — record the verification outcome
5. **Continue or fail** — decide next bounded action

### 2.2 Constraints

- Verification never fabricates certainty
- Verification always surfaces uncertainty
- Verification never exceeds authority
- Verification always respects STOP ALL
- Verification never performs real-money actions

---

## 3. Verification outcomes

### 3.1 Passed

The external action was verified successfully. The action is considered complete.

### 3.2 Failed

The external action verification failed. The action is considered failed.

### 3.3 Interrupted

The external action verification was interrupted (STOP ALL, owner cancellation,
deadline expiry). The action is paused.

### 3.4 Deadline-expired

The external action verification deadline expired. The action is failed.

---

## 4. Verification structure

### 4.1 Required fields

Every verification has:
- `verificationId`: a unique identifier
- `actionId`: the action being verified
- `environmentId`: the parent environment
- `outcome`: passed, failed, interrupted, or deadline-expired
- `reason`: why the verification passed/failed
- `verifiedAt`: when the verification was performed

### 4.2 Optional fields

- `evidence`: evidence supporting the verification outcome
- `confidence`: the confidence level of the verification

---

## 5. Verification and authority

### 5.1 Verification does not grant authority

Verification does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Perform real-money actions

### 5.2 Verification influences continuation only

Verification determines whether an action can continue. It does not change
what the subsystem is allowed to do.

---

## 6. Verification persistence

### 6.1 Durable storage

Verifications are stored in Vault. They survive restarts. They are
event-sourced — all changes are journaled.

### 6.2 Recovery

On restart:
1. Replay the journal
2. Rebuild verification state
3. Reconcile interrupted verifications
4. Resume or terminate explicitly

---

## 7. Verification invariants

These invariants must hold at all times:

1. **Every external action is verified** — No action is silently skipped.
2. **Every verification is bounded** — Every verification has a deadline.
3. **Every verification is deterministic** — Same state + same clock = same result.
4. **Verification is enforced by code** — Not by the model.
5. **Verification outcomes are journaled** — No silent verification.
6. **Verification survives restart** — Absolute deadlines, not relative.
7. **Verification does not grant authority** — Every action flows through existing authority.
8. **Verification never fabricates outcomes** — Outcomes are always derived from evidence.
