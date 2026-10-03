# Phase 33 — Task and Mission Orchestration

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Task and mission orchestration is the bounded coordination of tasks and missions
within enterprise boundaries. It extends the Phase 7 Missions and Phase 8
Workforce to operate within the Autonomous Enterprise / Webzone subsystem.

---

## 2. Task orchestration

### 2.1 Task lifecycle

| State | Description | Terminal? |
|---|---|---|
| `draft` | Task is being defined | No |
| `active` | Task is being executed | No |
| `paused` | Task is paused | No |
| `completed` | Task is complete | Yes |
| `failed` | Task has failed | Yes |
| `cancelled` | Task was cancelled | Yes |

### 2.2 Task transitions

| From | To | Condition |
|---|---|---|
| `draft` | `active` | Task is activated by owner or authorized event |
| `draft` | `cancelled` | Task is cancelled before activation |
| `active` | `paused` | STOP ALL, owner pause, budget exhaustion, dependency unmet |
| `active` | `completed` | All completion criteria are verified |
| `active` | `failed` | Deadline expires, retry ceiling reached, hard blocker |
| `paused` | `active` | Owner resumes, dependency met, budget available |
| `paused` | `cancelled` | Owner cancels |
| `completed` | — | Terminal |
| `failed` | — | Terminal |
| `cancelled` | — | Terminal |

### 2.3 Task structure

Every task has:
- `taskId`: a unique identifier
- `environmentId`: the parent environment
- `state`: one of the closed set of task states
- `title`: a bounded, human-readable title
- `description`: a bounded, human-readable description
- `completionCriteria`: explicit, verifiable criteria for completion
- `progress`: a number in [0, 1] representing completion progress
- `dependencies`: task IDs that must be completed before this task can start
- `deadlineAt`: an optional deadline
- `createdAt`, `updatedAt`, `completedAt`: timestamps

### 2.4 Task dependencies

- Dependencies are explicit — no implicit dependencies
- Dependencies are acyclic — cycles are detected and reported
- Dependencies are bounded — a task has at most 16 dependencies
- Dependencies are verifiable — each can be checked deterministically

---

## 3. Mission orchestration

### 3.1 Mission lifecycle

| State | Description | Terminal? |
|---|---|---|
| `draft` | Mission is being defined | No |
| `active` | Mission is being executed | No |
| `paused` | Mission is paused | No |
| `completed` | Mission is complete | Yes |
| `failed` | Mission has failed | Yes |
| `cancelled` | Mission was cancelled | Yes |

### 3.2 Mission transitions

| From | To | Condition |
|---|---|---|
| `draft` | `active` | Mission is activated by owner or authorized event |
| `draft` | `cancelled` | Mission is cancelled before activation |
| `active` | `paused` | STOP ALL, owner pause, budget exhaustion, dependency unmet |
| `active` | `completed` | All completion criteria are verified |
| `active` | `failed` | Deadline expires, retry ceiling reached, hard blocker |
| `paused` | `active` | Owner resumes, dependency met, budget available |
| `paused` | `cancelled` | Owner cancels |
| `completed` | — | Terminal |
| `failed` | — | Terminal |
| `cancelled` | — | Terminal |

### 3.3 Mission structure

Every mission has:
- `missionId`: a unique identifier
- `environmentId`: the parent environment
- `state`: one of the closed set of mission states
- `title`: a bounded, human-readable title
- `description`: a bounded, human-readable description
- `completionCriteria`: explicit, verifiable criteria for completion
- `progress`: a number in [0, 1] representing completion progress
- `childTaskIds`: task IDs that belong to this mission
- `deadlineAt`: an optional deadline
- `createdAt`, `updatedAt`, `completedAt`: timestamps

---

## 4. Orchestration process

### 4.1 Steps

1. **Validate** — validate the environment is active and boundaries hold
2. **Check spending** — check spending gates before orchestrating
3. **Authorize** — request cognition through Governor
4. **Orchestrate** — execute bounded task/mission operations
5. **Verify** — verify outcomes through ExternalActionVerification
6. **Continue or complete** — decide next bounded action

### 4.2 Constraints

- Orchestration never fabricates certainty
- Orchestration always surfaces uncertainty
- Orchestration never exceeds authority
- Orchestration always respects STOP ALL
- Orchestration never performs real-money actions
- Orchestration never crosses enterprise boundaries

---

## 5. Orchestration and authority

### 5.1 Orchestration does not grant authority

Orchestration does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Perform real-money actions

### 5.2 Orchestration influences ordering only

Orchestration determines the order in which the enterprise subsystem considers
work. It does not change what the subsystem is allowed to do.

---

## 6. Orchestration persistence

### 6.1 Durable storage

Tasks and missions are stored in Vault. They survive restarts. They are
event-sourced — all changes are journaled.

### 6.2 Recovery

On restart:
1. Replay the journal
2. Rebuild task/mission state
3. Reconcile interrupted tasks/missions
4. Resume or terminate explicitly

---

## 7. Orchestration invariants

These invariants must hold at all times:

1. **Orchestration is bounded** — Every task/mission has a deadline and completion criteria.
2. **Orchestration is deterministic** — Same state + same clock = same result.
3. **Orchestration does not grant authority** — Every action flows through existing authority.
4. **Orchestration is explainable** — Every task/mission carries reasoning.
5. **Orchestration is event-sourced** — All changes are journaled.
6. **Orchestration respects boundaries** — No task/mission crosses an enterprise boundary.
7. **Orchestration respects spending limits** — No task/mission exceeds a spending limit.
