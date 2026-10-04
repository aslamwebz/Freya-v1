# Phase 33 — Owner-Controlled Business Environment

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

The owner-controlled business environment is the primary vehicle for Autonomous
Enterprise / Webzone. It is a bounded, explicit business environment owned and
controlled by the owner. It is pursued through discrete, authorized, verifiable
wakes — never through hidden continuous reasoning.

---

## 2. Environment lifecycle

### 2.1 States

| State | Description | Terminal? |
|---|---|---|
| `draft` | Environment is being defined | No |
| `active` | Environment is being operated | No |
| `paused` | Environment is paused | No |
| `completed` | Environment is complete | Yes |
| `failed` | Environment has failed | Yes |
| `cancelled` | Environment was cancelled | Yes |

### 2.2 Transitions

| From | To | Condition |
|---|---|---|
| `draft` | `active` | Environment is activated by owner or authorized event |
| `draft` | `cancelled` | Environment is cancelled before activation |
| `active` | `paused` | STOP ALL, owner pause, budget exhaustion, boundary violation |
| `active` | `completed` | All completion criteria are verified |
| `active` | `failed` | Deadline expires, retry ceiling reached, hard blocker |
| `paused` | `active` | Owner resumes, budget available, boundary resolved |
| `paused` | `cancelled` | Owner cancels |
| `completed` | — | Terminal |
| `failed` | — | Terminal |
| `cancelled` | — | Terminal |

### 2.3 Invalid transitions

Any transition not in the table above is invalid and must be refused. The
environment state machine enforces this structurally.

---

## 3. Environment structure

### 3.1 Required fields

Every environment has:
- `environmentId`: a unique identifier
- `kind`: webzone, marketplace, service, or content
- `state`: one of the closed set of environment states
- `title`: a bounded, human-readable title
- `description`: a bounded, human-readable description
- `completionCriteria`: explicit, verifiable criteria for completion
- `progress`: a number in [0, 1] representing completion progress
- `boundaries`: explicit enterprise boundaries
- `spendingLimits`: explicit spending limits
- `deadlineAt`: an optional deadline
- `createdAt`, `updatedAt`, `completedAt`: timestamps

### 3.2 Optional fields

- `parentEnvironmentId`: for hierarchical environments
- `childEnvironmentIds`: for hierarchical environments
- `metadata`: bounded key-value pairs

---

## 4. Enterprise boundaries

### 4.1 Definition

Enterprise boundaries are explicit, code-owned limits that the enterprise
subsystem cannot cross. Each environment has its own boundaries.

### 4.2 Boundary properties

- Boundaries are explicit — no implicit boundaries
- Boundaries are code-owned — they cannot be widened at runtime
- Boundaries are enforced — every action is checked against boundaries
- Boundaries are journaled — every boundary check is durable
- Boundaries cannot be overridden by a model response

### 4.3 Boundary types

| Boundary | Description |
|---|---|
| `maxTasks` | Maximum number of tasks in this environment |
| `maxMissions` | Maximum number of missions in this environment |
| `maxWebzoneOperations` | Maximum number of webzone operations |
| `maxConcurrentOperations` | Maximum number of concurrent operations |
| `allowedDomains` | Domains the enterprise can operate in |
| `forbiddenActions` | Actions the enterprise cannot perform |

---

## 5. Spending limits

### 5.1 Definition

Spending limits are explicit, code-owned spending ceilings. Each environment
has its own spending limits.

### 5.2 Spending limit properties

- Spending limits are explicit — no implicit limits
- Spending limits are code-owned — they cannot be widened at runtime
- Spending limits are enforced — every consequential action is checked
- Spending limits are journaled — every spending gate check is durable
- Spending limits cannot be overridden by a model response
- Spending limits have a hard ceiling — the ceiling cannot be exceeded

### 5.3 Spending limit types

| Limit | Description |
|---|---|
| `maxTotalSpend` | Maximum total spend for this environment |
| `maxPerAction` | Maximum spend per action |
| `maxPerDay` | Maximum spend per day |
| `currency` | The currency for spending limits |
| `hardCeiling` | Whether the ceiling is hard (cannot be exceeded) |

---

## 6. Environment and authority

### 6.1 Environments do not grant authority

An environment does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Add real-money/economic actions
- Widen spending limits

### 6.2 Environments influence ordering only

Environments determine the order in which the enterprise subsystem considers
work. They do not change what the subsystem is allowed to do.

---

## 7. Environment persistence

### 7.1 Durable storage

Environments are stored in Vault. They survive restarts. They are event-sourced —
all changes are journaled.

### 7.2 Recovery

On restart:
1. Replay the journal
2. Rebuild environment state
3. Reconcile interrupted environments
4. Resume or terminate explicitly

### 7.3 Interrupted environment recovery

| State at interruption | Recovery |
|---|---|
| `draft` | → `draft` (can be activated) |
| `active` | → `paused` (re-evaluate on next wake) |
| `paused` | → `paused` (can be resumed) |
| `completed` | → `completed` (already finished) |
| `failed` | → `failed` (already failed) |
| `cancelled` | → `cancelled` (already cancelled) |

---

## 8. Environment invariants

These invariants must hold at all times:

1. **Environments are durable** — They survive restarts.
2. **Environments are deterministic** — Same state + same clock = same result.
3. **Environments do not grant authority** — Every action flows through existing authority.
4. **Environments are explainable** — Every environment carries reasoning.
5. **Environments are bounded** — Every environment has a deadline and completion criteria.
6. **Environments are event-sourced** — All changes are journaled.
7. **Environments are honest** — Progress is never fabricated.
8. **Enterprise boundaries are enforced** — No action crosses a boundary.
9. **Spending limits are enforced** — No action exceeds a spending limit.
