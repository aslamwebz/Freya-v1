# Phase 38 — Authority Drift Prevention Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Authority drift prevention is the explicit detection and prevention of
authority drift. It ensures that the evolution subsystem never widens its own
authority, never modifies its own boundaries, and never self-modifies trusted
runtime code.

---

## 2. Authority drift prevention process

### 2.1 Steps

1. **Define** — define the authority boundaries
2. **Monitor** — monitor all actions for authority drift
3. **Detect** — detect authority drift attempts
4. **Prevent** — prevent authority drift
5. **Journal** — journal all drift checks

### 2.2 Constraints

- Authority drift prevention never widens authority
- Authority drift prevention never self-modifies trusted runtime code
- Authority drift prevention never exceeds authority
- Authority drift prevention always respects STOP ALL

---

## 3. Authority boundaries

### 3.1 Definition

Authority boundaries are the explicit, code-owned limits that the evolution
subsystem cannot cross. They are defined by:
- Guard capabilities
- Governor authorization
- STOP ALL
- Budgets
- Approvals

### 3.2 Boundary properties

- Boundaries are explicit — no implicit boundaries
- Boundaries are code-owned — they cannot be widened at runtime
- Boundaries are enforced — every action is checked against boundaries
- Boundaries are journaled — every boundary check is durable
- Boundaries cannot be overridden by a model response

---

## 4. Drift detection

### 4.1 Detection method

Authority drift is detected when:
1. An action attempts to widen a capability
2. An action attempts to bypass Guard
3. An action attempts to bypass Governor
4. An action attempts to clear STOP ALL
5. An action attempts to exceed a budget
6. An action attempts to skip an approval
7. An action attempts to self-modify trusted runtime code

### 4.2 Detection properties

- Detection is deterministic — same action + same boundaries = same detection
- Detection is bounded — it completes within a deadline
- Detection is journaled — every detection is durable
- Detection never calls a model

---

## 5. Drift prevention

### 5.1 Prevention process

When authority drift is detected:
1. The action is refused
2. The refusal is journaled with a closed reason code
3. The owner is notified
4. No state change occurs
5. The boundary is not widened

### 5.2 Prevention properties

- Prevention is deterministic — same drift + same boundaries = same prevention
- Prevention is bounded — it completes within a deadline
- Prevention is journaled — every prevention is durable
- Prevention never calls a model
- Prevention never widens authority

---

## 6. Authority drift prevention and authority

### 6.1 Authority drift prevention does not grant authority

Authority drift prevention does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Self-modify trusted runtime code

### 6.2 Authority drift prevention constrains authority

Authority drift prevention constrains what the evolution subsystem can do
within its existing authority. It does not change what the subsystem is
allowed to do — it prevents the subsystem from widening its own authority.

---

## 7. Authority drift prevention persistence

### 7.1 Durable storage

Drift check records are stored in Vault. They survive restarts. They are
event-sourced — all changes are journaled.

### 7.2 Recovery

On restart:
1. Replay the journal
2. Rebuild drift check state
3. Reconcile interrupted checks
4. Resume or terminate explicitly

---

## 8. Authority drift prevention invariants

These invariants must hold at all times:

1. **Authority drift prevention is bounded** — Every drift check has a deadline.
2. **Authority drift prevention is deterministic** — Same action = same check.
3. **Authority drift prevention is journaled** — Every drift check is durable.
4. **Authority drift prevention does not grant authority** — Every action flows through existing authority.
5. **Authority drift prevention never widens authority** — Boundaries are never widened.
6. **Authority drift prevention never self-modifies** — Trusted runtime code is never self-modified.
7. **Authority drift is always detected** — No drift goes undetected.
8. **Authority drift is always prevented** — No drift succeeds.
