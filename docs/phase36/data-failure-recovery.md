# Phase 36 — Data Failure Recovery Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Data failure recovery is the bounded recovery from data corruption/loss. It
extends the existing event-sourced recovery architecture to handle data
failures with explicit quarantine, trusted prefix replay, and degraded-mode
reporting.

---

## 2. Data failure recovery process

### 2.1 Steps

1. **Detect** — detect data corruption/loss
2. **Quarantine** — quarantine corrupt data
3. **Replay** — replay trusted prefix
4. **Report** — report degraded mode
5. **Repair** — request owner approval for repair

### 2.2 Constraints

- Data failure recovery never fabricates data
- Data failure recovery never hides corruption
- Data failure recovery never exceeds authority
- Data failure recovery always respects STOP ALL
- Data failure recovery never self-modifies trusted runtime code

---

## 3. Data failure detection

### 3.1 Detection method

Data failure is detected when:
1. The journal is corrupt
2. The Vault is corrupt
3. The state is inconsistent with the journal
4. Checksums do not match

### 3.2 Detection properties

- Detection is deterministic — same data + same checksums = same detection
- Detection is bounded — it completes within a deadline
- Detection is journaled — every detection is durable
- Detection never calls a model

---

## 4. Quarantine

### 4.1 Quarantine process

When data corruption is detected:
1. The corrupt segment is quarantined
2. The trusted prefix is preserved
3. The quarantine is journaled
4. The owner is notified

### 4.2 Quarantine properties

- Quarantine is deterministic — same data + same corruption = same quarantine
- Quarantine is bounded — it completes within a deadline
- Quarantine is journaled — every quarantine is durable
- Quarantine never calls a model
- Quarantine never deletes data

---

## 5. Trusted prefix replay

### 5.1 Replay process

When data corruption is detected:
1. The trusted prefix is identified
2. The trusted prefix is replayed
3. The state is rebuilt from the trusted prefix
4. The replay is journaled

### 5.2 Replay properties

- Replay is deterministic — same trusted prefix = same state
- Replay is bounded — it completes within a deadline
- Replay is journaled — every replay is durable
- Replay never calls a model
- Replay never fabricates state

---

## 6. Data failure recovery and authority

### 6.1 Data failure recovery does not grant authority

Data failure recovery does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Self-modify trusted runtime code

### 6.2 Data failure recovery influences continuation only

Data failure recovery determines whether the subsystem can continue. It does
not change what the subsystem is allowed to do.

---

## 7. Data failure recovery persistence

### 7.1 Durable storage

Data failure recovery state is stored in Vault. It survives restarts. It is
event-sourced — all changes are journaled.

### 7.2 Recovery

On restart:
1. Replay the journal
2. Rebuild data failure recovery state
3. Reconcile interrupted operations
4. Resume or terminate explicitly

---

## 8. Data failure recovery invariants

These invariants must hold at all times:

1. **Data failure recovery is bounded** — Every recovery has a deadline.
2. **Data failure recovery is deterministic** — Same data = same recovery.
3. **Data failure recovery is journaled** — Every recovery is durable.
4. **Data failure recovery does not grant authority** — Every action flows through existing authority.
5. **Data failure recovery never fabricates data** — All state is derived from the journal.
6. **Data failure recovery never hides corruption** — Corruption is always surfaced.
7. **Data failure recovery never self-modifies** — Trusted runtime code is never self-modified.
