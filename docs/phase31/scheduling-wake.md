# Phase 31 — Bounded Scheduling and Wake Rules

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

The bounded scheduler is the deterministic, host-driven wake evaluation
mechanism for long-horizon continuation. It extends the Phase 23 heartbeat
mechanism with long-horizon-specific schedules and conditions.

A schedule is **not** a model call. A schedule is a deterministic evaluation of
whether a registered wake condition holds.

---

## 2. What a schedule is

### 2.1 Host-driven

The host calls `attentionTick()`. There is no self-scheduling timer in Core.
The schedule is driven by the application host (Electron main process), not
by Core itself.

### 2.2 Bounded

A schedule evaluates only registered schedules that are already due. It is
O(n) where n = number of pending schedules. It does not iterate over all
possible tasks.

### 2.3 Deterministic

Same state + same clock = same result. A schedule is a pure function of:
- Current Core state (replay-derived)
- Current time
- Registered schedules

### 2.4 No model call

A schedule never reaches a provider. It performs no model call, no network
access, no provider contact.

### 2.5 Fail-closed

If STOP ALL is active, the schedule does nothing. If the journal is corrupt,
the schedule does nothing.

### 2.6 Idempotent

A schedule that fires produces the same result as the previous schedule for
the same state. Repeated schedules do not produce duplicate events.

---

## 3. What a schedule is not

| Not | Why |
|---|---|
| Not a continuous timer | No `setInterval` or equivalent |
| Not a background reasoning loop | No hidden reasoning |
| Not a model call | No provider contact |
| Not a polling loop | No repeated evaluation without state change |
| Not a self-scheduling mechanism | Host-driven only |
| Not a new wake source | Uses existing wake sources |

---

## 4. Schedule conditions

### 4.1 Condition types

| Condition | Meaning |
|---|---|
| `always` | Fires when due |
| `focus-available` | Fires when owner is not focused |
| `goal-open` | Fires when the referenced goal is still open |

### 4.2 Condition evaluation

A condition is evaluated against already-authorized state. It does not create
new authority. It does not call a model.

---

## 5. Schedule lifecycle

### 5.1 States

| State | Description |
|---|---|
| `pending` | Schedule is registered and waiting |
| `fired` | Schedule has fired |
| `expired` | Schedule has expired |
| `cancelled` | Schedule was cancelled |

### 5.2 Transitions

| From | To | Condition |
|---|---|---|
| `pending` | `fired` | Due and condition holds |
| `pending` | `expired` | Past max horizon |
| `pending` | `cancelled` | Owner cancels |
| `fired` | `pending` | Repeating schedule, not at max repeats |
| `fired` | `expired` | Repeating schedule, at max repeats |
| `fired` | `cancelled` | Owner cancels |

---

## 6. Schedule limits

### 6.1 Code-owned ceilings

| Limit | Value |
|---|---|
| Max schedules | 64 |
| Max repeats | 8 |
| Min interval | 60 seconds |
| Max horizon | 30 days |

### 6.2 Enforcement

These limits are enforced by code. They cannot be widened at runtime. They
cannot be overridden by a model response.

---

## 7. Schedule and wake

### 7.1 Schedule fires a wake

When a schedule fires:
1. The schedule becomes an `authorized-event` wake
2. The wake is validated by WakeSourceRegistry
3. The pre-cognition filter evaluates the wake
4. If allowed, cognition is requested through the Governor
5. If cognition is allowed, the long-horizon subsystem acts

### 7.2 Schedule does not trigger cognition

The schedule itself does not trigger cognition. It triggers the wake, which
then decides.

---

## 8. Schedule and STOP ALL

If STOP ALL is active:
- The schedule does nothing
- No schedules fire
- No events are appended
- The long-horizon subsystem is halted

STOP ALL is checked before anything else, including schedule evaluation.

---

## 9. Schedule and journal integrity

If the journal is corrupt:
- The schedule does nothing
- No schedules fire
- The long-horizon subsystem is halted
- The owner is notified

Journal integrity is checked before schedule evaluation.

---

## 10. Schedule and goals

### 10.1 Goal-associated schedules

A schedule may be associated with a goal. When the schedule fires:
1. The goal's state is checked
2. If the goal is `active`, the schedule fires a wake
3. If the goal is not `active`, the schedule does not fire

### 10.2 Goal-open condition

The `goal-open` condition checks if the referenced goal is still open (not
`completed`, `failed`, or `cancelled`). If the goal is closed, the schedule
does not fire.

---

## 11. Schedule guarantees

These guarantees must hold at all times:

1. **No model call** — A schedule never reaches a provider.
2. **No continuous polling** — A schedule is host-driven, not self-scheduling.
3. **Deterministic** — Same state + same clock = same result.
4. **Fail-closed** — STOP ALL or corrupt journal halts the schedule.
5. **Idempotent** — Repeated schedules do not produce duplicate events.
6. **Bounded** — O(n) where n = pending schedules.
7. **No new authority** — A schedule does not create new authority.
