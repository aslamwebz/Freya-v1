# Phase 33 — Dependency Map

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This dependency map defines what Phase 33 depends on and what depends on Phase 33.
It is the contract between Phase 33 and the rest of the system.

Phase 33 is a **preparation-only** branch. It does not implement production
runtime behavior. It defines the architecture, interfaces, test plans, red-team
cases and acceptance criteria for Autonomous Enterprise / Webzone.

---

## 2. Predecessor dependencies

Phase 33 depends on these completed phases:

### 2.1 Phase 1 — Core authority

**Provides:**
- Guard (capability enforcement)
- Governor (cognition authorization)
- STOP ALL (immediate halt)
- Budgets (spend limits)
- Approvals (owner decisions)

**Phase 33 uses:**
- Guard to check capabilities before enterprise operations
- Governor to authorize cognition requests
- STOP ALL to halt all activity
- Budgets to limit enterprise spend
- Approvals to gate consequential actions

**Status:** completed

### 2.2 Phase 6 — Work execution engine

**Provides:**
- Run/Step/Action/Observation/Verification lifecycle
- Work limits and ceilings
- Approval workflow
- Capability risk taxonomy

**Phase 33 uses:**
- WorkEngine to execute bounded enterprise actions
- Run/Step lifecycle to track progress
- Verification to confirm outcomes
- Approval workflow to gate consequential actions

**Status:** completed

### 2.3 Phase 7 — Missions

**Provides:**
- Mission lifecycle (draft → active → paused → completed/failed/cancelled)
- Mission limits and ceilings
- Child Run attachment
- Verification workflow

**Phase 33 uses:**
- MissionEngine to track enterprise mission progress
- Mission lifecycle to prioritize enterprise work
- Child Run counts to assess mission health
- Verification workflow to confirm mission completion

**Status:** completed

### 2.4 Phase 8 — Workforce

**Provides:**
- Worker lifecycle (idle → working → blocked → stopped → retired)
- Worker budgets and spend
- Worker capabilities
- Assignment lifecycle
- Delegation records

**Phase 33 uses:**
- WorkforceEngine to delegate bounded enterprise work
- Worker lifecycle to track availability
- Worker budgets to limit delegation spend
- Worker capabilities to filter eligible workers
- Assignment lifecycle to track delegation progress

**Status:** completed

### 2.5 Phase 12 — Events and Attention

**Provides:**
- Attention event intake
- Attention policy (importance, urgency, outcome)
- Attention schedules
- Attention decisions

**Phase 33 uses:**
- AttentionEngine to receive events
- Attention policy to assess importance/urgency
- Attention decisions to trigger wakes
- Attention schedules to trigger heartbeats

**Status:** completed

### 2.6 Phase 23 — Continuous Life Loop

**Provides:**
- Event-driven, bounded continuation system
- Wake source validation
- Pre-cognition filter
- Continuation state machine
- Verification deadline enforcement

**Phase 33 uses:**
- Life Loop to drive enterprise decisions
- Wake source validation to ensure authorized wakes
- Pre-cognition filter to gate cognition
- Continuation state machine to manage enterprise state transitions

**Status:** in progress (branch `prep/phase23-life-loop`)

### 2.7 Phase 24 — Executive Intelligence

**Provides:**
- Prioritization, planning, coordination and uncertainty handling
- Executive state (explainable)
- Bounded delegation
- Retry ceilings and backoff

**Phase 33 uses:**
- Executive Intelligence to prioritize enterprise operations
- Planning to produce bounded next actions
- Coordination to delegate bounded work
- Uncertainty handling to surface assumptions and confidence

**Status:** in progress (branch `prep/phase24-executive`)

### 2.8 Phase 31 — Long-Horizon Autonomy

**Provides:**
- Persistent goal semantics
- Bounded scheduling/wake rules
- Interruption/preemption
- Verification/recovery
- Restart continuity
- Uncertainty handling

**Phase 33 uses:**
- Long-Horizon Autonomy to pursue multi-day/multi-week enterprise goals
- Bounded scheduling to evaluate enterprise opportunities
- Verification to confirm enterprise outcomes
- Restart continuity to survive restarts

**Status:** in progress (branch `prep/phase31-long-horizon`)

### 2.9 Phase 32 — Economic Intelligence

**Provides:**
- Research engine
- Simulation engine
- Paper trading engine
- Economic state (explainable)
- Evidence gathering with provenance

**Phase 33 uses:**
- Economic Intelligence to operate Webzone
- Research engine to identify opportunities
- Simulation engine to evaluate strategies
- Paper trading engine to test trading strategies

**Status:** in progress (branch `prep/phase32-economic-intelligence`)

---

## 3. Successor dependencies

These phases depend on Phase 33:

### 3.1 Phase 34+ — Future phases

**Depends on:**
- Phase 33's autonomous enterprise to operate business environments
- Phase 33's webzone interfaces to manage web presence
- Phase 33's spending gates to control spending
- Phase 33's rollback/recovery to recover from failures

**Status:** not started

---

## 4. Concurrent dependencies

These phases are being developed concurrently with Phase 33:

### 4.1 Phase 23 — Continuous Life Loop

**Relationship:** Phase 33 consumes Phase 23's wake events and continuation
state. Phase 23 is an event-driven continuation system.

**Contract:** Phase 23 provides wake events and continuation state. Phase 33
consumes them and produces enterprise decisions. Phase 33 does not write to
Phase 23.

**Status:** Phase 23 is in progress on branch `prep/phase23-life-loop`.

### 4.2 Phase 24 — Executive Intelligence

**Relationship:** Phase 33 consumes Phase 24's executive decisions and
coordination. Phase 24 is a prioritization, planning and coordination system.

**Contract:** Phase 24 provides executive decisions and coordination. Phase 33
consumes them and produces enterprise operations. Phase 33 does not write to
Phase 24.

**Status:** Phase 24 is in progress on branch `prep/phase24-executive`.

### 4.3 Phase 31 — Long-Horizon Autonomy

**Relationship:** Phase 33 consumes Phase 31's persistent goals, bounded
scheduling and continuation. Phase 31 is a long-horizon autonomy system.

**Contract:** Phase 31 provides persistent goals, bounded scheduling and
continuation. Phase 33 consumes them and produces enterprise operations. Phase 33
does not write to Phase 31.

**Status:** Phase 31 is in progress on branch `prep/phase31-long-horizon`.

### 4.4 Phase 32 — Economic Intelligence

**Relationship:** Phase 33 consumes Phase 32's research, simulation and paper
trading engines. Phase 32 is an economic intelligence system.

**Contract:** Phase 32 provides research, simulation and paper trading engines.
Phase 33 consumes them and produces enterprise operations. Phase 33 does not
write to Phase 32.

**Status:** Phase 32 is in progress on branch `prep/phase32-economic-intelligence`.

---

## 5. External dependencies

### 5.1 EventStore

**Provides:** Append-only event journal

**Phase 33 uses:** To journal enterprise decisions, environments, tasks,
missions, webzone operations, spending gate checks, verifications, rollbacks,
escalations, and red-team attempts.

**Status:** completed

### 5.2 Vault

**Provides:** Encrypted durable storage

**Phase 33 uses:** To store business environments, tasks, missions, webzone
operations, spending gates, approvals, verifications, and rollbacks.

**Status:** completed (canonical SQLCipher Vault on main)

### 5.3 Model Gateway

**Provides:** Provider-independent model access

**Phase 33 uses:** Phase 33 does NOT call models directly. It delegates to
Governor, which authorizes cognition requests.

**Status:** completed

---

## 6. Dependency constraints

### 6.1 Phase 33 does NOT depend on

- Phase 25 (Digital Senses & Hands II)
- Phase 26 (Natural Presence)
- Phase 27 (Relationship Intelligence II)
- Phase 28 (Experience → Knowledge → Skill)
- Phase 29 (Autonomous Capability Acquisition)
- Phase 30 (Self-Improving Architecture)

### 6.2 Phase 33 does NOT provide

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)
- Real-money actions (not owned by anyone — forbidden)

### 6.3 Phase 33 does NOT bypass

- Guard
- Governor
- STOP ALL
- Budgets
- Approvals
- Enterprise boundaries
- Spending gates

---

## 7. Integration points

### 7.1 With Phase 23 (Continuous Life Loop)

**Integration:** Phase 33 consumes Phase 23's wake events and continuation
state.

**Contract:**
- Phase 23 produces wake events with authorized sources
- Phase 33 consumes wake events and produces enterprise decisions
- Phase 33 does not produce wake events
- Phase 33 does not modify continuation state

**Status:** Phase 23 is in progress. Phase 33 will integrate when Phase 23 is
complete.

### 7.2 With Phase 24 (Executive Intelligence)

**Integration:** Phase 33 consumes Phase 24's executive decisions and
coordination.

**Contract:**
- Phase 24 produces executive decisions and coordination
- Phase 33 consumes them and produces enterprise operations
- Phase 33 does not write to Phase 24

**Status:** Phase 24 is in progress. Phase 33 will integrate when Phase 24 is
complete.

### 7.3 With Phase 31 (Long-Horizon Autonomy)

**Integration:** Phase 33 consumes Phase 31's persistent goals, bounded
scheduling and continuation.

**Contract:**
- Phase 31 produces persistent goals, bounded scheduling and continuation
- Phase 33 consumes them and produces enterprise operations
- Phase 33 does not write to Phase 31

**Status:** Phase 31 is in progress. Phase 33 will integrate when Phase 31 is
complete.

### 7.4 With Phase 32 (Economic Intelligence)

**Integration:** Phase 33 consumes Phase 32's research, simulation and paper
trading engines.

**Contract:**
- Phase 32 produces research, simulation and paper trading engines
- Phase 33 consumes them and produces enterprise operations
- Phase 33 does not write to Phase 32

**Status:** Phase 32 is in progress. Phase 33 will integrate when Phase 32 is
complete.

---

## 8. Risk assessment

### 8.1 Phase 23 not complete

**Risk:** Phase 33 cannot consume Phase 23's wake events.

**Mitigation:** Phase 33 defines its own wake event types. When Phase 23
is complete, Phase 33 integrates its wake events.

### 8.2 Phase 24 not complete

**Risk:** Phase 33 cannot consume Phase 24's executive decisions.

**Mitigation:** Phase 33 defines its own executive decision types. When Phase 24
is complete, Phase 33 integrates its executive decisions.

### 8.3 Phase 31 not complete

**Risk:** Phase 33 cannot consume Phase 31's persistent goals.

**Mitigation:** Phase 33 defines its own goal types. When Phase 31
is complete, Phase 33 integrates its goals.

### 8.4 Phase 32 not complete

**Risk:** Phase 33 cannot consume Phase 32's economic intelligence.

**Mitigation:** Phase 33 defines its own economic types. When Phase 32
is complete, Phase 33 integrates its economic types.

### 8.5 Concurrent development conflict

**Risk:** Phase 23, 24, 31, or 32 changes their contracts while Phase 33 is in
development.

**Mitigation:** Phase 33 defines its own interfaces. Integration happens
only when dependencies are green.

---

## 9. Dependency resolution order

Phase 33 implementation begins when:

1. Phase 23 (Continuous Life Loop) is complete
2. Phase 24 (Executive Intelligence) is complete
3. Phase 31 (Long-Horizon Autonomy) is complete
4. Phase 32 (Economic Intelligence) is complete
5. All predecessor dependencies are green
6. The owner approves the integration
7. PLAN.md is updated to reflect Phase 33 readiness

Until then, Phase 33 remains a preparation-only branch.
