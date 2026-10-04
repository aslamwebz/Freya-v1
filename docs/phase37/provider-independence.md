# Phase 37 — Provider Independence Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Provider independence is the capability to reason independently of any single
provider. It extends the existing Model Gateway architecture to provide
explicit provider routing, fallback, and health tracking.

---

## 2. Provider routing

### 2.1 Routing process

1. **Select** — select the highest-priority healthy provider
2. **Route** — route the reasoning request to the selected provider
3. **Verify** — verify the response
4. **Fallback** — fall back to the next provider on failure

### 2.2 Routing properties

- Routing is deterministic — same state + same clock = same routing
- Routing is bounded — it completes within a deadline
- Routing is journaled — every routing decision is durable
- Routing never calls a model for deterministic decisions
- Routing only uses owner-approved providers

---

## 3. Provider fallback

### 3.1 Fallback process

When a provider fails:
1. The failed provider is marked as failed
2. The next highest-priority healthy provider is selected
3. The request is retried with the new provider
4. The fallback is journaled

### 3.2 Fallback properties

- Fallback is deterministic — same provider list + same failure = same fallback
- Fallback is bounded — it completes within a deadline
- Fallback is journaled — every fallback is durable
- Fallback never calls a model for deterministic recovery
- Fallback only uses owner-approved providers

---

## 4. Provider health tracking

### 4.1 Health tracking process

1. Track provider response times
2. Track provider error rates
3. Track provider availability
4. Update provider status

### 4.2 Health tracking properties

- Health tracking is deterministic — same provider metrics = same status
- Health tracking is bounded — it completes within a deadline
- Health tracking is journaled — every status change is durable
- Health tracking never calls a model

---

## 5. Provider independence and authority

### 5.1 Provider independence does not grant authority

Provider independence does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Self-modify trusted runtime code

### 5.2 Provider independence influences routing only

Provider independence determines which provider handles a request. It does not
change what the subsystem is allowed to do.

---

## 6. Provider independence persistence

### 6.1 Durable storage

Provider state is stored in Vault. It survives restarts. It is event-sourced —
all changes are journaled.

### 6.2 Recovery

On restart:
1. Replay the journal
2. Rebuild provider state
3. Reconcile interrupted operations
4. Resume or terminate explicitly

---

## 7. Provider independence invariants

These invariants must hold at all times:

1. **Provider independence is bounded** — Every routing decision has a deadline.
2. **Provider independence is deterministic** — Same state = same routing.
3. **Provider independence is journaled** — Every routing decision is durable.
4. **Provider independence does not grant authority** — Every action flows through existing authority.
5. **Provider independence never adds new providers** — Only owner-approved providers are used.
6. **Provider independence never self-modifies** — Trusted runtime code is never self-modified.
