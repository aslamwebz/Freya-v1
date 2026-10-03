# Phase 31 — Persistent Goal Semantics

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Persistent goals are durable multi-day/multi-week objectives stored in Vault.
They are the primary vehicle for long-horizon autonomy. A persistent goal is
pursued through discrete, authorized, verifiable wakes — never through hidden
continuous reasoning.

---

## 2. Goal lifecycle

### 2.1 States

| State | Description | Terminal? |
|---|---|---|
| `draft` | Goal is being defined | No |
| `active` | Goal is being pursued | No |
| `paused` | Goal is paused | No |
| `completed` | Goal is complete | Yes |
| `failed` | Goal has failed | Yes |
| `cancelled` | Goal was cancelled | Yes |

### 2.2 Transitions

| From | To | Condition |
|---|---|---|
| `draft` | `active` | Goal is activated by owner or authorized event |
| `draft` | `cancelled` | Goal is cancelled before activation |
| `active` | `paused` | STOP ALL, owner pause, budget exhaustion, dependency unmet |
| `active` | `completed` | All completion criteria are verified |
| `active` | `failed` | Deadline expires, retry ceiling reached, hard blocker |
| `paused` | `active` | Owner resumes, dependency met, budget available |
| `paused` | `cancelled` | Owner cancels |
| `completed` | — | Terminal |
| `failed` | — | Terminal |
| `cancelled` | — | Terminal |

### 2.3 Invalid transitions

Any transition not in the table above is invalid and must be refused. The goal
state machine enforces this structurally.

---

## 3. Goal structure

### 3.1 Required fields

Every goal has:
- `goalId`: a unique identifier
- `kind`: mission, project, research, or maintenance
- `state`: one of the closed set of goal states
- `title`: a bounded, human-readable title
- `description`: a bounded, human-readable description
- `completionCriteria`: explicit, verifiable criteria for completion
- `progress`: a number in [0, 1] representing completion progress
- `dependencies`: goal IDs that must be completed before this goal can start
- `deadlineAt`: an optional deadline
- `createdAt`, `updatedAt`, `completedAt`: timestamps

### 3.2 Optional fields

- `parentGoalId`: for hierarchical goals
- `childGoalIds`: for hierarchical goals
- `metadata`: bounded key-value pairs

---

## 4. Completion criteria

### 4.1 Definition

Completion criteria are explicit, verifiable conditions that must all hold for
a goal to be considered complete. Each criterion is a statement that can be
verified deterministically.

### 4.2 Properties

- Criteria are explicit — no implicit criteria
- Criteria are verifiable — each can be checked deterministically
- Criteria are bounded — a goal has at most 64 criteria
- Criteria are ordered — they are checked in order

### 4.3 Verification

When all criteria are verified:
1. The goal's state transitions to `completed`
2. The transition is journaled
3. The completion is visible to the owner

---

## 5. Progress tracking

### 5.1 Definition

Progress is a number in [0, 1] representing how close the goal is to
completion. It is derived from:
- The number of verified completion criteria
- The number of verified checkpoints
- The goal's overall state

### 5.2 Properties

- Progress is deterministic — same state + same clock = same progress
- Progress is bounded — always in [0, 1]
- Progress is explainable — traceable to its inputs
- Progress is never fabricated — it is always derived from evidence

---

## 6. Goal dependencies

### 6.1 Definition

A goal may depend on other goals. A goal with unmet dependencies cannot
transition to `active`.

### 6.2 Properties

- Dependencies are explicit — no implicit dependencies
- Dependencies are acyclic — cycles are detected and reported
- Dependencies are bounded — a goal has at most 32 dependencies
- Dependencies are verifiable — each can be checked deterministically

### 6.3 Dependency resolution

When a goal's dependencies are met:
1. The goal's state transitions to `active` (if it was `draft`)
2. The transition is journaled
3. The goal becomes eligible for pursuit

---

## 7. Goal and authority

### 7.1 Goals do not grant authority

A goal does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Add real-money/economic actions

### 7.2 Goals influence ordering only

Goals determine the order in which the long-horizon subsystem considers work.
They do not change what the subsystem is allowed to do.

---

## 8. Goal persistence

### 8.1 Durable storage

Goals are stored in Vault. They survive restarts. They are event-sourced —
all changes are journaled.

### 8.2 Recovery

On restart:
1. Replay the journal
2. Rebuild goal state
3. Reconcile interrupted goals
4. Resume or terminate explicitly

### 8.3 Interrupted goal recovery

| State at interruption | Recovery |
|---|---|
| `draft` | → `draft` (can be activated) |
| `active` | → `paused` (re-evaluate on next wake) |
| `paused` | → `paused` (can be resumed) |
| `completed` | → `completed` (already finished) |
| `failed` | → `failed` (already failed) |
| `cancelled` | → `cancelled` (already cancelled) |

---

## 9. Goal invariants

These invariants must hold at all times:

1. **Goals are durable** — They survive restarts.
2. **Goals are deterministic** — Same state + same clock = same result.
3. **Goals do not grant authority** — Every action flows through existing authority.
4. **Goals are explainable** — Every goal carries reasoning.
5. **Goals are bounded** — Every goal has a deadline and completion criteria.
6. **Goals are event-sourced** — All changes are journaled.
7. **Goals are honest** — Progress is never fabricated.
