# Phase 36 — Degraded-Mode Honesty Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Degraded-mode honesty is the truthful operation of the subsystem in degraded
mode. It ensures that the subsystem never fabricates capability, never hides
degradation, and always reports its true state to the owner.

---

## 2. Degraded-mode levels

### 2.1 Levels

| Level | Description |
|---|---|
| `none` | Normal operation |
| `mild` | Minor degradation, full capability |
| `moderate` | Moderate degradation, reduced capability |
| `severe` | Severe degradation, significantly reduced capability |
| `critical` | Critical degradation, minimal capability |

### 2.2 Level properties

- Levels are explicit — no implicit levels
- Levels are code-owned — they cannot be widened at runtime
- Levels are enforced — every action is checked against the level
- Levels are journaled — every level transition is durable

---

## 3. Degraded-mode detection

### 3.1 Detection method

Degraded mode is detected when:
1. A subsystem is unavailable
2. A capability is reduced
3. A provider is failing
4. Data is corrupt
5. The journal is corrupt

### 3.2 Detection properties

- Detection is deterministic — same state + same conditions = same detection
- Detection is bounded — it completes within a deadline
- Detection is journaled — every detection is durable
- Detection never calls a model

---

## 4. Degraded-mode reporting

### 4.1 Reporting process

When degraded mode is detected:
1. The degraded-mode level is determined
2. The degraded-mode state is reported to the owner
3. The available capabilities are reported
4. The degradation reason is reported
5. The reporting is journaled

### 4.2 Reporting properties

- Reporting is deterministic — same state + same level = same report
- Reporting is bounded — it completes within a deadline
- Reporting is journaled — every report is durable
- Reporting never calls a model
- Reporting never fabricates capability
- Reporting never hides degradation

---

## 5. Degraded-mode operation

### 5.1 Operation constraints

In degraded mode:
1. Only available capabilities are used
2. No fabricated capability is presented
3. No hidden degradation is presented
4. The owner is always informed
5. The degradation is always visible

### 5.2 Operation properties

- Operation is deterministic — same state + same level = same operation
- Operation is bounded — it completes within a deadline
- Operation is journaled — every operation is durable
- Operation never calls a model for deterministic decisions
- Operation never fabricates capability
- Operation never hides degradation

---

## 6. Degraded-mode honesty and authority

### 6.1 Degraded-mode honesty does not grant authority

Degraded-mode honesty does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Self-modify trusted runtime code

### 6.2 Degraded-mode honesty influences operation only

Degraded-mode honesty determines what the subsystem can do in degraded mode.
It does not change what the subsystem is allowed to do.

---

## 7. Degraded-mode persistence

### 7.1 Durable storage

Degraded-mode state is stored in Vault. It survives restarts. It is
event-sourced — all changes are journaled.

### 7.2 Recovery

On restart:
1. Replay the journal
2. Rebuild degraded-mode state
3. Reconcile interrupted operations
4. Resume or terminate explicitly

---

## 8. Degraded-mode honesty invariants

These invariants must hold at all times:

1. **Degraded mode is truthful** — Degradation is never hidden.
2. **Degraded mode is bounded** — Every degraded-mode operation has a deadline.
3. **Degraded mode is deterministic** — Same state = same degraded mode.
4. **Degraded mode is journaled** — Every degraded-mode transition is durable.
5. **Degraded mode does not grant authority** — Every action flows through existing authority.
6. **Degraded mode never fabricates capability** — Capability is never fabricated.
7. **Degraded mode never self-modifies** — Trusted runtime code is never self-modified.
8. **Degraded mode is always visible** — The owner is always informed.
