# FREYA MIND — Phase 4 Architecture
## Unified Decision-Making and Executive Intelligence

**Date**: 2026-10-10  
**Branch**: `feat/mind-phase4-unified-decisions`  
**Status**: Implemented & Verified  

---

## 1. Executive Summary

Phase 4 elevates Freya from executing individual Missions in isolation to **intelligently managing multiple competing goals, deciding what deserves attention next, and allocating bounded resources within strict authority boundaries**.

Freya operates across multiple concurrent domains:
- **Mind** for reasoning, understanding, and formulating bounded plan proposals.
- **Missions** for durable goal records, step progress, and verification states.
- **Executive** for prioritizing competing eligible work and deciding optimal resource allocation.
- **Workforce** for maintaining subordinate worker rosters, teams, and assignment states.
- **Work** for executing registered capabilities and independently verifying outcomes.
- **Guard & Governor** for enforcing capability permissions, owner approvals, and cognition budgets.
- **LifeLoop** for event-driven wakes, schedules, and zero-idle background awareness.
- **Learning** for supplying verified prior experience as advisory evidence.

Phase 4 unifies these capabilities into an explainable, deterministic decision-making system answering:
1. *What should Freya work on next?*
2. *Why does one task matter more than another?*
3. *What can safely start now?*
4. *What must wait or be deferred?*
5. *Which worker or resource is available?*
6. *What has highest urgency or imminent deadline?*
7. *What requires owner approval?*
8. *When should a task be paused due to budget limits?*
9. *When must Freya stop immediately upon emergency override?*

---

## 2. Architectural Boundaries & Fundamental Invariant

```
+-----------------------------------------------------------------------------------+
|                               FREYA CORE                                          |
|                                                                                   |
|  +--------------------+   Proposals   +---------------------------------------+  |
|  |     Mind Domain    | ------------> |            Missions Domain            |  |
|  | (Goals & Planning) |               |     (Durable Goals & Step State)      |  |
|  +--------------------+               +---------------------------------------+  |
|                                                           |                       |
|                                              Authoritative Projections            |
|                                                           v                       |
|  +--------------------+   Advisory    +---------------------------------------+  |
|  |  Learning Domain   | ------------> |           Executive Domain            |  |
|  | (Closed-Loop Exp)  |               |  - Multi-Signal Prioritization        |  |
|  +--------------------+               |  - Specialisation Matching            |  |
|                                       |  - Fair Aging & Non-Starvation        |  |
|                                       |  - Budget & Checkpoint Safety         |  |
|                                       +---------------------------------------+  |
|                                                           |                       |
|                                              Decision Proposal (Start/Defer/Wait) |
|                                                           v                       |
|  +--------------------+               +---------------------------------------+  |
|  |  Guard & Governor  | <============ |             Work Domain               |  |
|  | (Authority Boundary|  Authorization|        (Authorized Execution)         |  |
|  |  & Budget Limits)  |               +---------------------------------------+  |
|  +--------------------+                                   |                       |
|           ^                                               v                       |
|           | STOP ALL                     +------------------------------------+  |
|           +----------------------------- |          Workforce Domain          |  |
|                                          |   (Subordinate Workers & Roster)   |  |
|                                          +------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

### The Invariant
> **Executive decides what is eligible and preferable. It does not grant permission to execute it.**

A scheduling preference must **never** override:
- `security.stopAll` panic overrides.
- User cancellation or refusal.
- Explicit approval requirements (`pendingApproval`).
- Guard capability permissions.
- Governor cognition budgets and thresholds.
- Mission-specific execution budgets (`budgetLimits` / `budgetSpends`).
- Worker concurrency ceilings or status limitations (`stopped`, `retired`, `suspended`).
- Independent verification requirements.

All decisions are strictly explainable from authoritative, durable state.

---

## 3. Subsystem Breakdown

### 3.1 Phase 4A — Unified Executive Composition
- **Location**: `core/executive/decision.ts`, `core/index.ts`.
- **Interface**:
  - `evaluateExecutiveDecision(input: ExecutiveDecisionInput): ExecutiveDecisionOutcome`
  - `core.executiveDecision(options?): ExecutiveDecisionOutcome`
  - `core.executiveState(options?): ExecutiveState`
- **Design**:
  - Pure function mapping authoritative projections of Missions, Workers, StopAll state, and Guard permissions into an explainable decision (`start`, `continue`, `defer`, `pause`, `escalate`, `no_action`).
  - Integrated via ports/adapters without duplicating orchestration engines or creating a parallel scheduler.
  - Safe fallbacks: missing missions produce `no_action` with reason `no_open_missions`.

### 3.2 Phase 4B — Intelligent Prioritization & Resource Allocation
- **Location**: `core/executive/decision.ts`, `core/executive/prioritizer.ts`, `core/executive/coordinator.ts`.
- **Multi-Signal Scoring**:
  $$\text{Score} = w_{\text{urgency}} \cdot R_{\text{urgency}} + w_{\text{importance}} \cdot R_{\text{importance}} + w_{\text{dependency}} \cdot R_{\text{dependency}} + w_{\text{intent}} \cdot R_{\text{intent}}$$
  where weights are code-owned ($0.35, 0.30, 0.20, 0.15$).
- **Fair Aging Policy**:
  Missions accumulate virtual age ($t_{\text{effective}} = t_{\text{created}} - \text{ageBonus}$) to prevent lower-priority starvation when multiple goals compete over extended periods.
- **Worker Specialisation Matching**:
  Missions may declare `allowedSpecialisations` (e.g. `research`, `writing`, `code`). The Executive filters worker pools, verifying both capabilities (`cognition.request`) and domain specialization.
- **Safe Checkpoint Preservation**:
  In-flight active steps (`currentStep.status === 'running'`) continue to safe verification checkpoints rather than being abruptly severed by preemption.
- **Budget Tracking**:
  Durable limit checks (`maxModelCalls`, `maxActions`, `maxExternalRequests`) prevent overrun, transitioning exhausted goals to `pause` with `budget_exhausted` before model calls occur.

### 3.3 Phase 4C — Event-Driven Decisions and Continuation
- **Location**: `core/executive/events.ts`, `core/index.ts`.
- **Zero Polling & Zero Idle Cost**:
  - No `setInterval`, no background timer loops, and no hidden model calls.
  - Re-evaluations occur strictly upon authoritative events matching `EXECUTIVE_TRIGGER_EVENT_PREFIXES` (`mission.`, `work.`, `workforce.`, `security.stop_all.`, `lifeloop.`, `approval.`).
  - Diagnostic and health pings (`core.health`, `diagnostics.`) are ignored.
- **Microtask Boundary**:
  Event observation uses `queueMicrotask` to guarantee that all aggregate reducers (WorkforceEngine, MissionEngine) finish folding live events into memory before the Executive computes decisions.
- **Subscriptions**:
  - `core.onExecutiveDecision((outcome) => void): () => void`
  - `core.lastExecutiveDecision(): ExecutiveDecisionOutcome | null`

### 3.4 Phase 4D — Real Multi-Mission Executive Intelligence
- **Multi-Candidate Scheduling Loop**:
  Instead of evaluating only the top-ranked mission and stalling if its worker is unavailable, the Executive iterates ranked eligible candidates:
  - Higher-priority goals whose resources are unavailable are recorded in `deferredMissions` with explicit causes (`specialised_worker_unavailable`, `workers_busy`).
  - Next-ranked eligible goals with available workers proceed immediately without starvation.
  - If no eligible mission has available resources, the Executive truthfully defers with explainable reasons.
- **Encrypted Persistence Recovery**:
  All mission priorities, workforce allocations, and executive state recover deterministically across clean restarts from encrypted SQLCipher Vault storage and event journals.

---

## 4. Decision Outcomes Vocabulary

| Decision | Meaning | Typical Trigger |
|---|---|---|
| `start` | Begin executing a ready or draft mission | Mission ready, worker available, highest priority |
| `continue` | Continue advancing an in-flight active mission | Active step in progress, verification pending |
| `defer` | Postpone work until a dependency or worker is free | Worker suspended/busy, missing specialization |
| `pause` | Temporarily halt execution to protect resources | Mission budget exhausted (`budget_exhausted`) |
| `escalate` | Alert owner of critical roadblock | Unresolvable conflict, expired hard deadline |
| `no_action` | Core rests safely without computation | No open missions, or `security.stopAll` active |
