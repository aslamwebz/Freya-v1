# Phase 37 — Offline / Local Reasoning Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Offline / local reasoning is the optional capability to reason without a
network connection. It operates within the same authority boundaries as
online reasoning. It does not widen authority.

---

## 2. Offline reasoning process

### 2.1 Steps

1. **Detect** — detect offline condition
2. **Transition** — transition to offline mode
3. **Reason** — reason using local/offline model
4. **Verify** — verify the reasoning outcome
5. **Transition** — transition back to online mode

### 2.2 Constraints

- Offline reasoning never fabricates certainty
- Offline reasoning always surfaces uncertainty
- Offline reasoning never exceeds authority
- Offline reasoning always respects STOP ALL
- Offline reasoning never self-modifies trusted runtime code

---

## 3. Offline modes

### 3.1 None

Normal online operation. No offline reasoning.

### 3.2 Full

Full offline reasoning. All reasoning is performed locally.

### 3.3 Partial

Partial offline reasoning. Some reasoning is performed locally, some is
deferred until online.

---

## 4. Offline reasoning detection

### 4.1 Detection method

Offline condition is detected when:
1. The network is unavailable
2. All providers are unreachable
3. The owner explicitly requests offline mode

### 4.2 Detection properties

- Detection is deterministic — same state + same conditions = same detection
- Detection is bounded — it completes within a deadline
- Detection is journaled — every detection is durable
- Detection never calls a model

---

## 5. Offline reasoning and authority

### 5.1 Offline reasoning does not grant authority

Offline reasoning does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Self-modify trusted runtime code

### 5.2 Offline reasoning influences reasoning only

Offline reasoning determines how reasoning is performed. It does not change
what the subsystem is allowed to do.

---

## 6. Offline reasoning persistence

### 6.1 Durable storage

Offline reasoning state is stored in Vault. It survives restarts. It is
event-sourced — all changes are journaled.

### 6.2 Recovery

On restart:
1. Replay the journal
2. Rebuild offline reasoning state
3. Reconcile interrupted operations
4. Resume or terminate explicitly

---

## 7. Offline reasoning invariants

These invariants must hold at all times:

1. **Offline reasoning is bounded** — Every offline reasoning session has a deadline.
2. **Offline reasoning is deterministic** — Same state = same offline reasoning.
3. **Offline reasoning is journaled** — Every offline reasoning session is durable.
4. **Offline reasoning does not grant authority** — Every action flows through existing authority.
5. **Offline reasoning never self-modifies** — Trusted runtime code is never self-modified.
6. **Offline reasoning respects authority** — Offline reasoning operates within the same authority boundaries as online reasoning.
