# Phase 31 — Long-Horizon Autonomy

**Status:** PREPARATION ONLY — NOT PRODUCTION  
**Branch:** `prep/phase31-long-horizon`  
**Blocked on:** Phase 27-30 and Phase 23/main integrations green  
**Required outcome:** safely continue multi-day/multi-week goals across restarts/events without hidden continuous spend

---

## 1. What this document is

This is a **preparation specification** for Phase 31. It defines the architecture,
interfaces, persistent-goal semantics, bounded scheduling/wake rules,
interruption/preemption, verification/recovery, restart continuity, uncertainty
handling, test plans, red-team cases and acceptance criteria for Long-Horizon
Autonomy. It does **not** implement production runtime behavior.

**Phase 31 cannot start until Phase 27-30 and Phase 23/main integrations are
green.** This branch exists so that when the gate passes, implementation can
begin immediately without re-deriving the design.

---

## 2. The core invariant

> **Long-horizon autonomy is bounded continuation, not continuous reasoning.
> A multi-day goal is pursued through discrete, authorized, verifiable wakes —
> never through hidden continuous spend.**

Long-Horizon Autonomy extends the Continuous Life Loop (Phase 23) and Executive
Intelligence (Phase 24) to span multiple days and weeks. It does **not** widen
the authority boundaries established by Guard, Governor, STOP ALL, approvals
and budgets. It decides *what to do next* across a longer horizon, but every
consequential action still flows through the existing authority paths.

---

## 3. Scope

Phase 31 delivers:

1. **Persistent goal semantics** — durable multi-day/multi-week goals with
   explicit state, progress tracking and completion criteria
2. **Bounded scheduling/wake rules** — deterministic, host-driven wake
   evaluation for long-horizon continuation
3. **Interruption/preemption** — STOP ALL, owner preemption, Guard denial,
   budget exhaustion, deadline expiry
4. **Verification/recovery** — outcome verification, retry ceilings, backoff
5. **Restart continuity** — event-sourced recovery across process restarts
6. **Uncertainty handling** — assumptions, confidence, stale/conflicted
   evidence, reversible decisions
7. **No hidden continuous spend** — zero idle inference, no background
   reasoning, no continuous polling
8. **Explainable long-horizon state** — what is being pursued, why, what is
   blocked, what is uncertain, next bounded action
9. **No authority widening** — every action flows through Guard, Governor,
   STOP ALL, approvals and budgets

---

## 4. What Phase 31 explicitly does NOT do

- Does NOT add autonomous browser/terminal permissions
- Does NOT add spending authority
- Does NOT add unrestricted loops
- Does NOT add hidden model calls
- Does NOT add durable stores outside Vault
- Does NOT add any new authority
- Does NOT bypass Guard, Governor, STOP ALL, approvals or budgets
- Does NOT change PLAN.md
- Does NOT merge to main
- Does NOT bypass the integration gate
- Does NOT add real-money/economic actions
- Does NOT add UI branch touches
- Does NOT add continuous background reasoning
- Does NOT add self-scheduling timers

---

## 5. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    LONG-HORIZON AUTONOMY                            │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐     │
│  │  PERSISTENT  │  │  BOUNDED     │  │   LONG-HORIZON       │     │
│  │  GOAL STORE  │  │  SCHEDULER   │  │   CONTINUATION       │     │
│  │              │  │              │  │                      │     │
│  │ goal state   │  │ wake eval    │  │ multi-day spans      │     │
│  │ progress     │  │ schedule     │  │ restart recovery     │     │
│  │ completion   │  │ deadlines    │  │ verification         │     │
│  │ criteria     │  │              │  │ uncertainty          │     │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘     │
│         │                 │                      │                  │
│         └────────┬────────┘                      │                  │
│                  │                              │                  │
│         ┌────────┴──────────────────────────────┴────────┐        │
│         │           LONG-HORIZON STATE                   │        │
│         │  what is pursued / why / blocked / uncertain /  │        │
│         │  next bounded action                           │        │
│         └────────────────────┬──────────────────────────┘        │
│                              │                                    │
│  ┌───────────────────────────┴───────────────────────────────┐   │
│  │              EXISTING AUTHORITY BOUNDARIES                │   │
│  │  Guard │ Governor │ STOP ALL │ Approvals │ Budgets       │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                      │
│  NO new authority. NO hidden inference. NO autonomous spend.        │
│  NO continuous reasoning. NO real-money actions.                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Component details

### 6.1 Persistent Goal Store

- Durable multi-day/multi-week goals in Vault
- Goal state machine: `draft → active → paused → completed/failed/cancelled`
- Progress tracking with explicit completion criteria
- Goal dependencies and ordering
- No model calls

### 6.2 Bounded Scheduler

- Deterministic, host-driven wake evaluation
- Schedule conditions: `always`, `focus-available`, `goal-open`
- Schedule limits: max 64 schedules, max 8 repeats, min 60s interval
- Max horizon: 30 days
- No model calls

### 6.3 Long-Horizon Continuation

- Multi-day goal spans with explicit checkpoints
- Event-sourced recovery across restarts
- Verification at each checkpoint
- Uncertainty tracking and surfacing
- No model calls

### 6.4 Long-Horizon State (explainable)

- What is being pursued now
- Why it matters
- What is blocked
- What is uncertain
- Next bounded action

---

## 7. Authority preservation

Every long-horizon decision flows through:
1. Guard capability check
2. Governor cognition authorization
3. STOP ALL latch check
4. Budget remaining check
5. Approval requirement check

No component can bypass any of these.

---

## 8. Test plan summary

See `docs/phase31/test-plan.md` for the full test plan.

Key test categories:
1. Unit tests — goal store, scheduler, continuation
2. Integration tests — full long-horizon flow
3. Red-team tests — authority escalation attempts
4. Zero-idle-inference tests — no model call without wake
5. Restart recovery tests — event-driven resumption
6. Multi-day span tests — goal continuation across wakes

---

## 9. Acceptance criteria summary

See `docs/phase31/acceptance-criteria.md` for full acceptance criteria.

Key criteria:
1. No continuous polling or hidden reasoning
2. Every wake is from an authorized source
3. Every cognition is gated by Governor
4. Every action is bounded and verifiable
5. STOP ALL immediately halts everything
6. Restart recovery is deterministic
7. Zero idle inference is proven
8. No authority escalation from any input
9. Multi-day goals survive restarts
10. No real-money/economic actions

---

## 10. Document index

| Document | Purpose |
|---|---|
| `docs/phase31/architecture.md` | Architecture specification |
| `docs/phase31/interfaces.md` | Compile-time types/interfaces |
| `docs/phase31/persistent-goals.md` | Persistent goal semantics |
| `docs/phase31/scheduling-wake.md` | Bounded scheduling/wake rules |
| `docs/phase31/interruption-preemption.md` | Interruption/preemption |
| `docs/phase31/verification-recovery.md` | Verification/recovery |
| `docs/phase31/restart-continuity.md` | Restart continuity |
| `docs/phase31/uncertainty-handling.md` | Uncertainty handling |
| `docs/phase31/acceptance-criteria.md` | Acceptance criteria |
| `docs/phase31/test-plan.md` | Test plan |
| `docs/phase31/red-team-cases.md` | Red-team cases |
| `docs/phase31/dependency-map.md` | Dependency map |

---

## 11. NOT PRODUCTION — blocked on integration gate

This entire branch is **preparation only**. No production runtime behavior is
implemented. No code in this branch activates runtime behavior. The branch
contains only documentation, specifications, interfaces and test plans.

**Phase 31 implementation begins only when:**
1. Phase 27-30 integrations are green
2. Phase 23/main integrations are green
3. The owner explicitly approves the integration
4. PLAN.md is updated to reflect Phase 31 readiness

Until then, this branch is **blocked** and must not be merged to main.
