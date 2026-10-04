# Phase 36 — Repair Workflows Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Repair workflows are the bounded, authorized repair processes for the subsystem.
They ensure that repairs are explicit, authorized, auditable, and reversible.
No unauthorized repair is performed. No trusted runtime code is self-modified.

---

## 2. Repair workflow process

### 2.1 Steps

1. **Detect** — detect repairable condition
2. **Assess** — assess the repair scope and risk
3. **Authorize** — request owner approval for consequential repairs
4. **Execute** — execute the bounded repair
5. **Verify** — verify the repair outcome
6. **Report** — report the repair status

### 2.2 Constraints

- Repair never fabricates certainty
- Repair always surfaces uncertainty
- Repair never exceeds authority
- Repair always respects STOP ALL
- Repair never self-modifies trusted runtime code
- Repair never performs unauthorized repairs

---

## 3. Repair detection

### 3.1 Detection method

A repairable condition is detected when:
1. A subsystem is in a failed state
2. Data is corrupt but recoverable
3. A provider is failing but recoverable
4. A backup is available for restore

### 3.2 Detection properties

- Detection is deterministic — same state + same conditions = same detection
- Detection is bounded — it completes within a deadline
- Detection is journaled — every detection is durable
- Detection never calls a model

---

## 4. Repair assessment

### 4.1 Assessment process

When a repairable condition is detected:
1. The repair scope is determined
2. The repair risk is assessed
3. The repair reversibility is assessed
4. The assessment is journaled

### 4.2 Assessment properties

- Assessment is deterministic — same state + same conditions = same assessment
- Assessment is bounded — it completes within a deadline
- Assessment is journaled — every assessment is durable
- Assessment never calls a model
- Assessment never fabricates results

---

## 5. Repair authorization

### 5.1 Authorization process

For consequential repairs:
1. The repair scope is presented to the owner
2. The owner approves or denies the repair
3. The authorization is journaled
4. The repair proceeds only if authorized

### 5.2 Authorization properties

- Authorization is explicit — no implicit authorization
- Authorization is durable — stored in the journal
- Authorization is auditable — every authorization is journaled
- Authorization is bounded — at most 16 pending authorizations
- Authorization is never skipped — no consequential repair bypasses authorization

---

## 6. Repair execution

### 6.1 Execution process

To execute a repair:
1. The repair scope is validated
2. The repair is executed within authority
3. The repair outcome is verified
4. The repair is journaled

### 6.2 Execution properties

- Execution is deterministic — same state + same repair = same result
- Execution is bounded — it completes within a deadline
- Execution is journaled — every repair is durable
- Execution never calls a model for deterministic repairs
- Execution never self-modifies trusted runtime code
- Execution never performs unauthorized repairs

---

## 7. Repair verification

### 7.1 Verification process

After a repair:
1. The repair outcome is verified
2. The subsystem state is validated
3. The verification is journaled
4. The owner is notified

### 7.2 Verification properties

- Verification is deterministic — same repair + same state = same result
- Verification is bounded — it completes within a deadline
- Verification is journaled — every verification is durable
- Verification never calls a model
- Verification never fabricates results

---

## 8. Repair workflows and authority

### 8.1 Repair workflows do not grant authority

Repair workflows do not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Self-modify trusted runtime code

### 8.2 Repair workflows influence recovery only

Repair workflows determine whether a condition can be repaired. They do not
change what the subsystem is allowed to do.

---

## 9. Repair workflow persistence

### 9.1 Durable storage

Repair workflow state is stored in Vault. It survives restarts. It is
event-sourced — all changes are journaled.

### 9.2 Recovery

On restart:
1. Replay the journal
2. Rebuild repair workflow state
3. Reconcile interrupted repairs
4. Resume or terminate explicitly

---

## 10. Repair workflow invariants

These invariants must hold at all times:

1. **Repair workflows are bounded** — Every repair has a deadline.
2. **Repair workflows are deterministic** — Same state = same repair.
3. **Repair workflows are journaled** — Every repair is durable.
4. **Repair workflows do not grant authority** — Every action flows through existing authority.
5. **Repair workflows never self-modify** — Trusted runtime code is never self-modified.
6. **Repair workflows are authorized** — No unauthorized repair is performed.
7. **Repair workflows are verified** — Every repair is verified.
8. **Repair workflows are reversible** — Reversible repairs can be rolled back.
