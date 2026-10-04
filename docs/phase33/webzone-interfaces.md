# Phase 33 — Web Presence / Workzone Interfaces

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Web presence / workzone interfaces are the bounded, auditable interfaces for web
presence and workzone operations within the Autonomous Enterprise / Webzone
subsystem. They provide the interface between the enterprise subsystem and
the owner's web presence.

---

## 2. Webzone operation lifecycle

### 2.1 States

| State | Description | Terminal? |
|---|---|---|
| `pending` | Operation is queued | No |
| `active` | Operation is being executed | No |
| `paused` | Operation is paused | No |
| `completed` | Operation is complete | Yes |
| `failed` | Operation has failed | Yes |
| `cancelled` | Operation was cancelled | Yes |

### 2.2 Transitions

| From | To | Condition |
|---|---|---|
| `pending` | `active` | Operation is activated by owner or authorized event |
| `pending` | `cancelled` | Operation is cancelled before activation |
| `active` | `paused` | STOP ALL, owner pause, budget exhaustion |
| `active` | `completed` | Operation completed successfully |
| `active` | `failed` | Operation failed |
| `paused` | `active` | Owner resumes, budget available |
| `paused` | `cancelled` | Owner cancels |
| `completed` | — | Terminal |
| `failed` | — | Terminal |
| `cancelled` | — | Terminal |

---

## 3. Webzone operation types

### 3.1 Publish

Publish content to the owner's web presence.

**Properties:**
- Content is bounded (max 65536 bytes)
- Content is auditable (journaled)
- Content is reversible (can be rolled back)
- Content requires approval (if consequential)

### 3.2 Update

Update existing content on the owner's web presence.

**Properties:**
- Updates are bounded
- Updates are auditable
- Updates are reversible
- Updates require approval (if consequential)

### 3.3 Delete

Delete content from the owner's web presence.

**Properties:**
- Deletions are bounded
- Deletions are auditable
- Deletions are reversible (content is preserved for rollback)
- Deletions require owner approval

### 3.4 Query

Query the owner's web presence.

**Properties:**
- Queries are bounded
- Queries are auditable
- Queries are read-only
- Queries do not require approval

### 3.5 Interact

Interact with the owner's web presence (e.g., respond to comments).

**Properties:**
- Interactions are bounded
- Interactions are auditable
- Interactions are reversible
- Interactions require approval (if consequential)

---

## 4. Webzone operation structure

### 4.1 Required fields

Every webzone operation has:
- `operationId`: a unique identifier
- `environmentId`: the parent environment
- `state`: one of the closed set of webzone operation states
- `kind`: publish, update, delete, query, or interact
- `target`: the target of the operation
- `payload`: the operation payload (bounded)
- `createdAt`, `completedAt`: timestamps

### 4.2 Optional fields

- `verificationId`: the verification record for this operation
- `rollbackId`: the rollback record for this operation

---

## 5. Webzone interface boundaries

### 5.1 Operation boundaries

| Boundary | Value | Description |
|---|---|---|
| Max operations per environment | 128 | Maximum operations |
| Max operation duration | 24 hours | Maximum operation duration |
| Max concurrent operations | 4 | Maximum concurrent operations |
| Max payload size | 65536 bytes | Maximum payload size |

### 5.2 Domain boundaries

Webzone operations can only target domains in the `allowedDomains` list of the
enterprise boundaries. Operations targeting other domains are refused.

### 5.3 Action boundaries

Webzone operations cannot perform actions in the `forbiddenActions` list of the
enterprise boundaries. Operations performing those actions are refused.

---

## 6. Webzone interface and authority

### 6.1 Webzone interfaces do not grant authority

Webzone interfaces do not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Perform real-money actions

### 6.2 Webzone interfaces influence ordering only

Webzone interfaces determine the order in which the enterprise subsystem
considers web presence operations. They do not change what the subsystem is
allowed to do.

---

## 7. Webzone operation persistence

### 7.1 Durable storage

Webzone operations are stored in Vault. They survive restarts. They are
event-sourced — all changes are journaled.

### 7.2 Recovery

On restart:
1. Replay the journal
2. Rebuild webzone operation state
3. Reconcile interrupted operations
4. Resume or terminate explicitly

---

## 8. Webzone interface invariants

These invariants must hold at all times:

1. **Webzone operations are bounded** — Every operation has a duration limit.
2. **Webzone operations are auditable** — Every operation is journaled.
3. **Webzone operations do not grant authority** — Every action flows through existing authority.
4. **Webzone operations respect boundaries** — No operation crosses an enterprise boundary.
5. **Webzone operations respect spending limits** — No operation exceeds a spending limit.
6. **Webzone operations are verified** — No operation is considered complete without verification.
7. **Webzone operations are reversible** — Reversible operations can be rolled back.
