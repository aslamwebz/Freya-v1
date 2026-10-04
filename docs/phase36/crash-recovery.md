# Phase 36 — Crash Recovery Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Crash recovery is the bounded, deterministic recovery from process crashes.
It extends the existing event-sourced recovery architecture (Phases 9, 23, 31)
to handle process crashes with explicit reconciliation and resumption.

---

## 2. Crash recovery process

### 2.1 Steps

1. **Detect** — detect process crash on restart
2. **Replay** — replay the event journal
3. **Rebuild** — rebuild all subsystem state
4. **Reconcile** — reconcile interrupted operations
5. **Resume or terminate** — resume or terminate explicitly

### 2.2 Constraints

- Crash recovery never fabricates state
- Crash recovery never silently continues interrupted work
- Crash recovery never exceeds authority
- Crash recovery always respects STOP ALL
- Crash recovery never self-modifies trusted runtime code

---

## 3. Crash detection

### 3.1 Detection method

A process crash is detected when:
1. The previous process did not shut down cleanly
2. The journal has uncommitted events
3. The state is inconsistent with the journal

### 3.2 Detection properties

- Detection is deterministic — same journal + same state = same detection
- Detection is bounded — it completes within a deadline
- Detection is journaled — every detection is durable
- Detection never calls a model

---

## 4. State rebuild

### 4.1 Rebuild process

On crash detection:
1. Read all events from the journal
2. Fold them into CoreState using `reduceCoreState`
3. Rebuild all subsystem state
4. Reconcile interrupted states
5. Resume or terminate explicitly

### 4.2 Rebuild properties

- Rebuild is deterministic — same journal = same state
- Rebuild is bounded — it completes within a deadline
- Rebuild is journaled — every rebuild is durable
- Rebuild never calls a model

---

## 5. Interrupted operation reconciliation

### 5.1 Operation states at crash

| State at crash | Recovery |
|---|---|
| `pending` | → `pending` (can be started) |
| `active` | → `paused` (re-evaluate on next wake) |
| `paused` | → `paused` (can be resumed) |
| `completed` | → `completed` (already finished) |
| `failed` | → `failed` (already failed) |
| `cancelled` | → `cancelled` (already cancelled) |

### 5.2 Reconciliation properties

- Reconciliation is deterministic — same journal + same state = same result
- Reconciliation is bounded — it completes within a deadline
- Reconciliation is journaled — every reconciliation is durable
- Reconciliation never calls a model

---

## 6. Crash recovery and authority

### 6.1 Crash recovery does not grant authority

Crash recovery does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Self-modify trusted runtime code

### 6.2 Crash recovery influences continuation only

Crash recovery determines whether an operation can continue. It does not
change what the subsystem is allowed to do.

---

## 7. Crash recovery persistence

### 7.1 Durable storage

Crash recovery state is stored in Vault. It survives restarts. It is
event-sourced — all changes are journaled.

### 7.2 Recovery

On restart:
1. Replay the journal
2. Rebuild crash recovery state
3. Reconcile interrupted operations
4. Resume or terminate explicitly

---

## 8. Crash recovery invariants

These invariants must hold at all times:

1. **Crash recovery is bounded** — Every recovery has a deadline.
2. **Crash recovery is deterministic** — Same journal = same recovery.
3. **Crash recovery is journaled** — Every recovery is durable.
4. **Crash recovery does not grant authority** — Every action flows through existing authority.
5. **Crash recovery never fabricates state** — All state is derived from the journal.
6. **Crash recovery never silently continues** — Interrupted work is not silently continued.
7. **Crash recovery never self-modifies** — Trusted runtime code is never self-modified.
