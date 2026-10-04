# Phase 32 — Economic Intelligence

**Status:** RUNTIME IMPLEMENTED — FAIL-CLOSED / CORE ACTIVATION PENDING  
**Branch:** `runtime/phase32-economic-intelligence`  
**Blocked on:** deliberate Core/Phase-31 seam activation only  
**Required outcome:** research, simulation/paper experiments and measured economic evidence — no real money

---

## 1. What this document is

This document now accompanies the implemented Phase 32 Economic Intelligence runtime.
The domain runtime, event vocabulary, validation, protocol surface, simulations,
paper experiments, recovery logic, and red-team coverage are implemented.

Core does **not** activate the runtime yet. `NO_LONG_HORIZON_SEAM` remains the
default and no `core/index.ts` path instantiates Economic Intelligence, so the
feature is fail-closed until a deliberate Phase-31/Core seam is supplied. This is
an explicit integration boundary, not an implicit permission to execute.

---

## 2. The core invariant

> **Economic Intelligence is research, simulation and paper trading only.
> No real money, no real spending, no real financial transactions.**

Economic Intelligence enables Freya to research market/business
opportunities, gather evidence, run backtests/simulations, and conduct paper
trading experiments with zero real capital. It does **not** widen the authority
boundaries established by Guard, Governor, STOP ALL, approvals and budgets.
It does **not** perform any real-money action.

---

## 3. Scope

Phase 32 delivers:

1. **Market/business research** — bounded, cited evidence gathering
2. **Evidence gathering** — structured, provenance-carrying evidence
3. **Backtests/simulations** — deterministic, bounded simulations
4. **Paper trading** — simulated trading with zero real capital
5. **Measurable result tracking** — explicit metrics with denominators
6. **No real money** — no real-money/economic actions
7. **No authority widening** — every action flows through Guard, Governor,
   STOP ALL, approvals and budgets
8. **Explainable economic state** — what is being researched, what is
   uncertain, what the evidence shows

---

## 4. What Phase 32 explicitly does NOT do

- Does NOT perform real-money trading
- Does NOT perform real spending
- Does NOT perform real financial transactions
- Does NOT add spending authority
- Does NOT add autonomous browser/terminal permissions
- Does NOT add unrestricted loops
- Does NOT add hidden model calls
- Does NOT add durable stores outside Vault
- Does NOT add any new authority
- Does NOT bypass Guard, Governor, STOP ALL, approvals or budgets
- Does NOT change PLAN.md
- Does NOT merge to main
- Does NOT bypass the integration gate
- Does NOT add UI branch touches
- Does NOT add continuous background reasoning
- Does NOT add self-scheduling timers

---

## 5. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ECONOMIC INTELLIGENCE                            │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐     │
│  │   RESEARCH   │  │  SIMULATION  │  │   PAPER TRADING      │     │
│  │              │  │              │  │                      │     │
│  │ market scan  │  │ backtests    │  │ simulated orders     │     │
│  │ evidence     │  │ scenarios    │  │ paper portfolio      │     │
│  │ citations    │  │ projections  │  │ performance metrics  │     │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘     │
│         │                 │                      │                  │
│         └────────┬────────┘                      │                  │
│                  │                              │                  │
│         ┌────────┴──────────────────────────────┴────────┐        │
│         │           ECONOMIC STATE                       │        │
│         │  what is researched / what is uncertain /     │        │
│         │  what the evidence shows / next bounded action │        │
│         └────────────────────┬──────────────────────────┘        │
│                              │                                    │
│  ┌───────────────────────────┴───────────────────────────────┐   │
│  │              EXISTING AUTHORITY BOUNDARIES                │   │
│  │  Guard │ Governor │ STOP ALL │ Approvals │ Budgets       │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                      │
│  NO new authority. NO real money. NO hidden inference.              │
│  NO continuous reasoning. NO spending authority.                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Component details

### 6.1 Research Engine

- Bounded market/business research
- Evidence gathering with provenance and citations
- No model calls for deterministic research
- No real-money actions

### 6.2 Simulation Engine

- Deterministic backtests and scenarios
- Bounded projections with explicit assumptions
- No model calls for deterministic simulation
- No real-money actions

### 6.3 Paper Trading Engine

- Simulated order placement (no real orders)
- Paper portfolio tracking
- Performance metrics with explicit denominators
- No real-money actions

### 6.4 Economic State (explainable)

- What is being researched
- What is uncertain
- What the evidence shows
- Next bounded action

---

## 7. Authority preservation

Every economic decision flows through:
1. Guard capability check
2. Governor cognition authorization
3. STOP ALL latch check
4. Budget remaining check
5. Approval requirement check

No component can bypass any of these. No component can perform a real-money
action.

---

## 8. Test plan summary

See `docs/phase32/test-plan.md` for the full test plan.

Key test categories:
1. Unit tests — research, simulation, paper trading
2. Integration tests — full economic intelligence flow
3. Red-team tests — real-money action attempts
4. Zero-idle-inference tests — no model call without wake
5. Restart recovery tests — event-driven resumption

---

## 9. Acceptance criteria summary

See `docs/phase32/acceptance-criteria.md` for full acceptance criteria.

Key criteria:
1. No continuous polling or hidden reasoning
2. Every wake is from an authorized source
3. Every cognition is gated by Governor
4. Every action is bounded and verifiable
5. STOP ALL immediately halts everything
6. Restart recovery is deterministic
7. Zero idle inference is proven
8. No authority escalation from any input
9. No real-money/economic actions
10. All metrics have explicit denominators

---

## 10. Document index

| Document | Purpose |
|---|---|
| `docs/phase32/architecture.md` | Architecture specification |
| `docs/phase32/interfaces.md` | Compile-time types/interfaces |
| `docs/phase32/research-engine.md` | Research engine specification |
| `docs/phase32/simulation-engine.md` | Simulation engine specification |
| `docs/phase32/paper-trading.md` | Paper trading specification |
| `docs/phase32/economic-state.md` | Explainable economic state |
| `docs/phase32/acceptance-criteria.md` | Acceptance criteria |
| `docs/phase32/test-plan.md` | Test plan |
| `docs/phase32/red-team-cases.md` | Red-team cases |
| `docs/phase32/dependency-map.md` | Dependency map |

---

## 11. NOT PRODUCTION — blocked on integration gate

This entire branch is **preparation only**. No production runtime behavior is
implemented. No code in this branch activates runtime behavior. The branch
contains only documentation, specifications, interfaces and test plans.

**Phase 32 implementation begins only when:**
1. Phase 31 and earlier integrations are green
2. The owner explicitly approves the integration
3. PLAN.md is updated to reflect Phase 32 readiness

Until then, this branch is **blocked** and must not be merged to main.
