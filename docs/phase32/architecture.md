# Phase 32 — Architecture Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Economic Intelligence is the subsystem that enables Freya to research
market/business opportunities, gather evidence, run backtests/simulations, and
conduct paper trading experiments with zero real capital. It extends the
Long-Horizon Autonomy (Phase 31) to span economic research and experimentation.

The core invariant:

> **Economic Intelligence is research, simulation and paper trading only.
> No real money, no real spending, no real financial transactions.**

Every decision flows through existing authority paths (Guard, Governor,
STOP ALL, approvals, budgets). No new authority is created. No real-money
action is performed.

---

## 2. Design principles

### 2.1 Research only

Economic Intelligence performs research, simulation and paper trading. It does
not perform real-money actions. It does not perform real spending. It does not
perform real financial transactions.

### 2.2 Bounded experimentation

Every experiment is bounded:
- A maximum number of scenarios
- A maximum duration
- A deadline after which it stops
- A way to be interrupted by STOP ALL

### 2.3 Deterministic before cognitive

Every decision before a model call is deterministic: same state + same clock
= same result. This is testable, auditable, and safe.

### 2.4 Authority-preserving

The economic subsystem cannot:
- Create grants
- Widen budgets
- Bypass Guard
- Override Governor
- Clear STOP ALL
- Approve its own requests
- Perform real-money actions

### 2.5 Explainable

Every economic decision carries:
- What was decided
- Why it was decided
- What alternatives were considered
- What is uncertain
- What is blocked

### 2.6 Zero hidden spend

No model call without a wake. No continuous polling. No hidden reasoning.
No background processing. No self-scheduling timers.

---

## 3. Components

### 3.1 ResearchEngine (new, Phase 32)

Bounded market/business research. Gathers evidence with provenance and
citations.

**Responsibilities:**
- Gather market/business evidence
- Structure evidence with provenance
- Cite sources
- Detect stale/conflicted evidence

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Perform real-money actions

### 3.2 SimulationEngine (new, Phase 32)

Deterministic backtests and scenarios. Bounded projections with explicit
assumptions.

**Responsibilities:**
- Run deterministic backtests
- Run bounded scenarios
- Produce projections with explicit assumptions
- Track simulation metrics

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Perform real-money actions

### 3.3 PaperTradingEngine (new, Phase 32)

Simulated order placement (no real orders). Paper portfolio tracking.
Performance metrics with explicit denominators.

**Responsibilities:**
- Place simulated orders (no real orders)
- Track paper portfolio
- Compute performance metrics
- Journal all paper trading activity

**Does NOT:**
- Call a model
- Create authority
- Bypass Guard
- Perform real-money actions
- Place real orders

### 3.4 EconomicStateMachine (new, Phase 32)

Manages the economic state transitions. Extends the Phase 31 long-horizon
state machine with economic-specific states.

**States:**
- `IDLE` — No active economic experiment
- `RESEARCHING` — Research is being conducted
- `SIMULATING` — A simulation is running
- `PAPER_TRADING` — Paper trading is active
- `ANALYZING` — Results are being analyzed
- `COMPLETE` — The experiment is complete (terminal)
- `FAILED` — The experiment has failed (terminal)

### 3.5 EconomicState (new, Phase 32)

The explainable economic state. Answers:
- What is being researched
- What is uncertain
- What the evidence shows
- Next bounded action

---

## 4. Data flow

```
Wake event
    │
    ▼
WakeSourceRegistry.validate(wake)
    │
    ├─ invalid → DENY (journaled)
    │
    ▼ valid
BoundedScheduler.evaluate(schedules)
    │
    ├─ no schedule due → IDLE
    │
    ▼ schedule fired
PreCognitionFilter.evaluate(wake, state)
    │
    ├─ deny → DENY (journaled)
    ├─ wait → WAIT (journaled, with deadline)
    │
    ▼ allow
EconomicStateMachine.evaluate(experiments)
    │
    ├─ no active experiment → IDLE
    │
    ▼ active experiment
Governor.evaluate(request)
    │
    ├─ deny → DENY (journaled)
    │
    ▼ allow
CognitionService.request(intent)
    │
    ├─ denied → DENY (journaled)
    ├─ failed → ANALYZING (retry or fail)
    │
    ▼ allowed
ResearchEngine / SimulationEngine / PaperTradingEngine
    │
    ▼
Verification
    │
    ├─ passed → ANALYZING (continue or complete)
    ├─ failed → FAILED (or retry)
    │
    ▼
Continuation decision
    │
    ├─ continue → RESEARCHING/SIMULATING/PAPER_TRADING (next step)
    ├─ complete → COMPLETE (terminal)
    ├─ fail → FAILED (terminal)
```

---

## 5. Integration with existing subsystems

### 5.1 Phase 31 — Long-Horizon Autonomy

The economic subsystem uses the long-horizon subsystem's persistent goals,
bounded scheduler and continuation state machine. It does not replace them;
it extends them with economic-specific states and transitions.

### 5.2 Phase 23 — Continuous Life Loop

The economic subsystem uses the life loop's wake mechanism, pre-cognition
filter and continuation state machine. It does not replace them; it extends
them with economic-specific states and transitions.

### 5.3 Phase 24 — Executive Intelligence

The economic subsystem uses the executive layer's prioritization, planning
and coordination. It does not replace them; it extends them with economic
experiment tracking.

### 5.4 Guard

The economic subsystem checks capabilities through `Guard.evaluate()`. It
does not bypass Guard.

### 5.5 Governor

The economic subsystem requests cognition through `Governor.evaluate()`.
It does not bypass Governor.

### 5.6 EventStore

The economic subsystem appends events through `EventFabric.append()`. It
does not create a parallel store.

### 5.7 Vault

The economic subsystem stores research, simulation and paper trading data in
Vault. It does not create new durable stores.

---

## 6. Boundaries

### 6.1 What the economic subsystem owns

- Research engine
- Simulation engine
- Paper trading engine
- Economic state machine
- Economic state projection

### 6.2 What the economic subsystem does NOT own

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)
- Real-money actions (not owned by anyone — forbidden)

---

## 7. Failure modes

| Failure | Handling |
|---|---|
| Wake from unauthorized source | Denied, journaled |
| Pre-cognition filter denies | Denied, journaled |
| Governor denies | Denied, journaled |
| Provider fails | Experiment failed, retry or fail |
| Verification fails | Experiment failed or retry |
| Deadline expires | Terminal outcome |
| STOP ALL activated | Immediate halt |
| Journal corrupt | Deny everything |
| Restart during experiment | Reconcile interrupted experiment |
| Budget exhausted | Experiment paused |
| Real-money action attempted | Refused, journaled |

---

## 8. Economic invariants

These invariants must hold at all times:

1. **No real money** — No real-money action is performed.
2. **No continuous reasoning** — Economic experiments are pursued through discrete wakes.
3. **No hidden spend** — No model call without a wake.
4. **No authority widening** — Every action flows through existing authority.
5. **Deterministic** — Same state + same clock = same result.
6. **Event-sourced** — All state is derived from the journal.
7. **Explainable** — Every decision carries reasoning.
8. **Bounded** — Every experiment has a deadline and completion criteria.
9. **Metrics have denominators** — Every metric has an explicit denominator.
