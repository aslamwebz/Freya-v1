# Phase 32 — Simulation Engine Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

The Simulation Engine is the subsystem that enables Freya to run deterministic
backtests and bounded scenarios. It produces projections with explicit
assumptions and tracks simulation metrics. It is bounded, deterministic and
explainable.

---

## 2. Simulation process

### 2.1 Steps

1. **Define** — define the simulation scenario and parameters
2. **Assume** — create explicit assumptions for gaps
3. **Run** — run the deterministic simulation
4. **Verify** — verify the simulation outcome
5. **Report** — produce a bounded, explainable simulation report

### 2.2 Constraints

- Simulation never fabricates certainty
- Simulation always surfaces uncertainty
- Simulation never exceeds authority
- Simulation always respects STOP ALL
- Simulation never performs real-money actions

---

## 3. Scenarios

### 3.1 Definition

A scenario is a defined set of parameters and assumptions for a simulation.
Each scenario has:
- A unique identifier
- An experiment reference
- A name
- A set of parameters (bounded key-value pairs)
- A set of assumptions
- A status (pending, running, completed, failed)
- A result (when completed)

### 3.2 Properties

- Scenarios are explicit — no implicit parameters
- Scenarios are bounded — at most 32 scenarios per experiment
- Scenarios are deterministic — same parameters + same clock = same result
- Scenarios are explainable — every result carries its assumptions

### 3.3 Scenario limits

| Limit | Value |
|---|---|
| Max scenarios per experiment | 32 |
| Max simulation duration | 24 hours |
| Max parameters per scenario | 64 |
| Max assumptions per scenario | 32 |

---

## 4. Simulation results

### 4.1 Definition

A simulation result is the output of a completed scenario. Each result has:
- A unique identifier
- A scenario reference
- A set of metrics (bounded key-value pairs)
- A start timestamp
- A completion timestamp

### 4.2 Properties

- Results are deterministic — same scenario + same clock = same result
- Results are bounded — at most 64 metrics per result
- Results are explainable — every metric carries its assumptions
- Results are honest — uncertainty is never hidden

---

## 5. Simulation and authority

### 5.1 Simulation does not grant authority

Simulation does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Perform real-money actions

### 5.2 Simulation influences planning only

Simulation determines what the economic subsystem projects. It does not change
what the subsystem is allowed to do.

---

## 6. Simulation persistence

### 6.1 Durable storage

Simulation data is stored in Vault. It survives restarts. It is event-sourced —
all changes are journaled.

### 6.2 Recovery

On restart:
1. Replay the journal
2. Rebuild simulation state
3. Reconcile interrupted simulations
4. Resume or terminate explicitly

---

## 7. Simulation invariants

These invariants must hold at all times:

1. **Simulation is bounded** — Every scenario has a duration limit.
2. **Simulation is deterministic** — Same parameters + same clock = same result.
3. **Simulation is explainable** — Every result carries its assumptions.
4. **Simulation is honest** — Uncertainty is never hidden.
5. **Simulation does not grant authority** — Every action flows through existing authority.
6. **Simulation performs no real-money actions** — No real-money action is performed.
