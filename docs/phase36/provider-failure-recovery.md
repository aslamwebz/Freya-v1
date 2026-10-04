# Phase 36 — Provider Failure Recovery Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Provider failure recovery is the bounded recovery from model provider failures.
It extends the existing Model Gateway architecture to handle provider failures
with explicit fallback, retry, and reporting.

---

## 2. Provider failure recovery process

### 2.1 Steps

1. **Detect** — detect provider failure
2. **Fallback** — fall back to owner-approved provider
3. **Retry** — retry with backoff
4. **Report** — report provider status
5. **Escalate** — escalate to owner if unrecoverable

### 2.2 Constraints

- Provider failure recovery never adds new providers
- Provider failure recovery never exceeds authority
- Provider failure recovery always respects STOP ALL
- Provider failure recovery never self-modifies trusted runtime code

---

## 3. Provider failure detection

### 3.1 Detection method

Provider failure is detected when:
1. The provider returns an error
2. The provider times out
3. The provider returns an invalid response
4. The provider is unreachable

### 3.2 Detection properties

- Detection is deterministic — same provider response = same detection
- Detection is bounded — it completes within a deadline
- Detection is journaled — every detection is durable
- Detection never calls a model

---

## 4. Provider fallback

### 4.1 Fallback process

When a provider failure is detected:
1. The current provider is marked as failed
2. The next owner-approved provider is selected
3. The request is retried with the new provider
4. The fallback is journaled

### 4.2 Fallback properties

- Fallback is deterministic — same provider list + same failure = same fallback
- Fallback is bounded — it completes within a deadline
- Fallback is journaled — every fallback is durable
- Fallback never calls a model for deterministic recovery
- Fallback never adds new providers
- Fallback only uses owner-approved providers

---

## 5. Retry with backoff

### 5.1 Retry process

When a provider failure is detected:
1. The retry count is checked
2. If the retry ceiling is not reached, the request is retried
3. The backoff delay is computed
4. The retry is journaled

### 5.2 Retry properties

- Retry is deterministic — same state + same clock = same retry
- Retry is bounded — it completes within a deadline
- Retry is journaled — every retry is durable
- Retry never calls a model for deterministic recovery
- Retry never exceeds the retry ceiling
- Retry never exceeds the maximum backoff

---

## 6. Provider failure recovery and authority

### 6.1 Provider failure recovery does not grant authority

Provider failure recovery does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Self-modify trusted runtime code

### 6.2 Provider failure recovery influences continuation only

Provider failure recovery determines whether a request can continue. It does
not change what the subsystem is allowed to do.

---

## 7. Provider failure recovery persistence

### 7.1 Durable storage

Provider failure recovery state is stored in Vault. It survives restarts. It is
event-sourced — all changes are journaled.

### 7.2 Recovery

On restart:
1. Replay the journal
2. Rebuild provider failure recovery state
3. Reconcile interrupted operations
4. Resume or terminate explicitly

---

## 8. Provider failure recovery invariants

These invariants must hold at all times:

1. **Provider failure recovery is bounded** — Every recovery has a deadline.
2. **Provider failure recovery is deterministic** — Same state = same recovery.
3. **Provider failure recovery is journaled** — Every recovery is durable.
4. **Provider failure recovery does not grant authority** — Every action flows through existing authority.
5. **Provider failure recovery never adds new providers** — Only owner-approved providers are used.
6. **Provider failure recovery never self-modifies** — Trusted runtime code is never self-modified.
7. **Provider failure recovery never exceeds retry ceiling** — No infinite retry loop.
