# Phase 31 — Verification and Recovery

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Every long-horizon goal checkpoint must be verified before the goal can
continue. Verification is bounded, deterministic and journaled. Recovery from
verification failure is explicit and bounded.

---

## 2. Checkpoint verification

### 2.1 Definition

A checkpoint is a verifiable milestone within a long-horizon goal. Each
checkpoint has:
- A description
- A status (pending, in-progress, verified, failed)
- A verification outcome (passed, failed, interrupted, deadline-expired)
- A timestamp

### 2.2 Verification process

1. A checkpoint is created when a goal reaches a milestone
2. The checkpoint is verified deterministically
3. The verification outcome is journaled
4. If passed, the goal continues to the next checkpoint
5. If failed, the goal is paused or failed

### 2.3 Verification properties

- Verification is deterministic — same state + same clock = same result
- Verification is bounded — every verification has a deadline
- Verification is journaled — every outcome is durable
- Verification is explainable — every outcome carries a reason

---

## 3. Verification outcomes

### 3.1 Passed

The checkpoint was verified successfully. The goal continues to the next
checkpoint.

### 3.2 Failed

The checkpoint verification failed. The goal is paused or failed.

### 3.3 Interrupted

The checkpoint verification was interrupted (STOP ALL, owner cancellation,
deadline expiry). The goal is paused.

### 3.4 Deadline-expired

The checkpoint verification deadline expired. The goal is failed.

---

## 4. Retry ceilings

### 4.1 Checkpoint retry ceiling

**Default:** 3 attempts (`LONG_HORIZON_LIMITS.maxRetryCeiling`)  
**Purpose:** How many times a failed checkpoint may retry.  
**Enforcement:** The long-horizon subsystem checks the attempt count before
each retry. If the ceiling is reached, the checkpoint is marked `failed` with
reason `limit-attempts`.

### 4.2 Goal retry ceiling

**Default:** 1 (no goal retry)  
**Purpose:** A goal does not retry. A new goal must be created.  
**Enforcement:** The long-horizon subsystem does not permit goal retry. A
failed goal stays `failed` forever.

---

## 5. Backoff

### 5.1 Backoff strategy

Exponential backoff with jitter:

```
delay = min(baseDelay * 2^attempt + random(0, jitter), maxDelay)
```

### 5.2 Backoff parameters

| Parameter | Default |
|---|---|
| Base delay | 1 second |
| Max delay | 5 minutes |
| Jitter | 0-1000 milliseconds |

### 5.3 Backoff enforcement

The backoff is enforced by the subsystem before each retry. The subsystem does
not retry immediately; it waits for the backoff period.

---

## 6. Recovery

### 6.1 Checkpoint recovery

When a checkpoint fails:
1. The checkpoint is marked `failed`
2. The failure is journaled
3. The goal is paused (if retry ceiling not reached) or failed (if reached)
4. The owner is notified

### 6.2 Goal recovery

When a goal fails:
1. The goal is marked `failed`
2. The failure is journaled
3. The owner is notified
4. The owner may create a new goal to continue the work

### 6.3 Interrupted goal recovery

When a goal is interrupted:
1. The goal is marked `paused`
2. The interruption is journaled
3. The owner may resume the goal

---

## 7. Verification and authority

### 7.1 Verification does not grant authority

A verified checkpoint does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements

### 7.2 Verification influences continuation only

Verification determines whether a goal can continue. It does not change what
the subsystem is allowed to do.

---

## 8. Verification deadlines

### 8.1 Checkpoint verification deadline

**Default:** 24 hours (`LONG_HORIZON_LIMITS.maxCheckpointVerificationMs`)  
**Purpose:** How long a checkpoint verification may run before it is considered failed.  
**Enforcement:** The long-horizon subsystem checks the deadline before each
verification step. If the deadline has passed, the checkpoint is marked
`failed` with reason `deadline-expired`.

### 8.2 Goal deadline

**Default:** 90 days (`LONG_HORIZON_LIMITS.maxGoalDurationMs`)  
**Purpose:** How long a goal may run before it is considered failed.  
**Enforcement:** The long-horizon subsystem checks the goal deadline. If the
deadline has passed, the goal is marked `failed` with reason `deadline-expired`.

---

## 9. Verification guarantees

These guarantees must hold at all times:

1. **Every checkpoint is verified** — No checkpoint is silently skipped.
2. **Every verification is bounded** — Every verification has a deadline.
3. **Every retry has a ceiling** — No infinite retry loop.
4. **Every backoff has a maximum** — No unbounded backoff.
5. **Verification is enforced by code** — Not by the model.
6. **Verification outcomes are journaled** — No silent verification.
7. **Verification survives restart** — Absolute deadlines, not relative.
