# Phase 32 — Dependency Map

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This dependency map defines what Phase 32 depends on and what depends on Phase 32.
It is the contract between Phase 32 and the rest of the system.

Phase 32 is a **preparation-only** branch. It does not implement production
runtime behavior. It defines the architecture, interfaces, test plans, red-team
cases and acceptance criteria for Economic Intelligence.

---

## 2. Predecessor dependencies

Phase 32 depends on these completed phases:

### 2.1 Phase 1 — Core authority

**Provides:**
- Guard (capability enforcement)
- Governor (cognition authorization)
- STOP ALL (immediate halt)
- Budgets (spend limits)
- Approvals (owner decisions)

**Phase 32 uses:**
- Guard to check capabilities before research/simulation/paper-trading
- Governor to authorize cognition requests
- STOP ALL to halt all activity
- Budgets to limit experiment spend
- Approvals to gate consequential actions

**Status:** completed

### 2.2 Phase 6 — Work execution engine

**Provides:**
- Run/Step/Action/Observation/Verification lifecycle
- Work limits and ceilings
- Approval workflow
- Capability risk taxonomy

**Phase 32 uses:**
- WorkEngine to execute bounded research/simulation/paper-trading actions
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

**Phase 32 uses:**
- MissionEngine to track experiment progress
- Mission lifecycle to prioritize experiments
- Child Run counts to assess experiment health
- Verification workflow to confirm experiment completion

**Status:** completed

### 2.4 Phase 8 — Workforce

**Provides:**
- Worker lifecycle (idle → working → blocked → stopped → retired)
- Worker budgets and spend
- Worker capabilities
- Assignment lifecycle
- Delegation records

**Phase 32 uses:**
- WorkforceEngine to delegate bounded research/simulation/paper-trading work
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

**Phase 32 uses:**
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

**Phase 32 uses:**
- Life Loop to drive economic decisions
- Wake source validation to ensure authorized wakes
- Pre-cognition filter to gate cognition
- Continuation state machine to manage economic state transitions

**Status:** in progress (branch `prep/phase23-life-loop`)

### 2.7 Phase 24 — Executive Intelligence

**Provides:**
- Prioritization, planning, coordination and uncertainty handling
- Executive state (explainable)
- Bounded delegation
- Retry ceilings and backoff

**Phase 32 uses:**
- Executive Intelligence to prioritize economic experiments
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

**Phase 32 uses:**
- Long-Horizon Autonomy to pursue multi-day/multi-week economic goals
- Bounded scheduling to evaluate economic opportunities
- Verification to confirm economic outcomes
- Restart continuity to survive restarts

**Status:** in progress (branch `prep/phase31-long-horizon`)

---

## 3. Successor dependencies

These phases depend on Phase 32:

### 3.1 Phase 33 — Autonomous Enterprise

**Depends on:**
- Phase 32's economic intelligence to operate Webzone
- Phase 32's research engine to identify opportunities
- Phase 32's simulation engine to evaluate strategies
- Phase 32's paper trading engine to test trading strategies

**Status:** not started

---

## 4. Concurrent dependencies

These phases are being developed concurrently with Phase 32:

### 4.1 Phase 23 — Continuous Life Loop

**Relationship:** Phase 32 consumes Phase 23's wake events and continuation
state. Phase 23 is an event-driven continuation system.

**Contract:** Phase 23 provides wake events and continuation state. Phase 32
consumes them and produces economic decisions. Phase 32 does not write to
Phase 23.

**Status:** Phase 23 is in progress on branch `prep/phase23-life-loop`.

### 4.2 Phase 24 — Executive Intelligence

**Relationship:** Phase 32 consumes Phase 24's executive decisions and
coordination. Phase 24 is a prioritization, planning and coordination system.

**Contract:** Phase 24 provides executive decisions and coordination. Phase 32
consumes them and produces economic experiments. Phase 32 does not write to
Phase 24.

**Status:** Phase 24 is in progress on branch `prep/phase24-executive`.

### 4.3 Phase 31 — Long-Horizon Autonomy

**Relationship:** Phase 32 consumes Phase 31's persistent goals, bounded
scheduling and continuation. Phase 31 is a long-horizon autonomy system.

**Contract:** Phase 31 provides persistent goals, bounded scheduling and
continuation. Phase 32 consumes them and produces economic experiments. Phase 32
does not write to Phase 31.

**Status:** Phase 31 is in progress on branch `prep/phase31-long-horizon`.

---

## 5. External dependencies

### 5.1 EventStore

**Provides:** Append-only event journal

**Phase 32 uses:** To journal economic decisions, experiments, evidence,
simulations, paper orders, escalations, and red-team attempts.

**Status:** completed

### 5.2 Vault

**Provides:** Encrypted durable storage

**Phase 32 uses:** To store research, simulation and paper trading data.

**Status:** completed (canonical SQLCipher Vault on main)

### 5.3 Model Gateway

**Provides:** Provider-independent model access

**Phase 32 uses:** Phase 32 does NOT call models directly. It delegates to
Governor, which authorizes cognition requests.

**Status:** completed

---

## 6. Dependency constraints

### 6.1 Phase 32 does NOT depend on

- Phase 25 (Digital Senses & Hands II)
- Phase 26 (Natural Presence)
- Phase 27 (Relationship Intelligence II)
- Phase 28 (Experience → Knowledge → Skill)
- Phase 29 (Autonomous Capability Acquisition)
- Phase 30 (Self-Improving Architecture)
- Phase 33 (Autonomous Enterprise)

### 6.2 Phase 32 does NOT provide

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)
- Real-money actions (not owned by anyone — forbidden)

### 6.3 Phase 32 does NOT bypass

- Guard
- Governor
- STOP ALL
- Budgets
- Approvals

---

## 7. Integration points

### 7.1 With Phase 23 (Continuous Life Loop)

**Integration:** Phase 32 consumes Phase 23's wake events and continuation
state.

**Contract:**
- Phase 23 produces wake events with authorized sources
- Phase 32 consumes wake events and produces economic decisions
- Phase 32 does not produce wake events
- Phase 32 does not modify continuation state

**Status:** Phase 23 is in progress. Phase 32 will integrate when Phase 23 is
complete.

### 7.2 With Phase 24 (Executive Intelligence)

**Integration:** Phase 32 consumes Phase 24's executive decisions and
coordination.

**Contract:**
- Phase 24 produces executive decisions and coordination
- Phase 32 consumes them and produces economic experiments
- Phase 32 does not write to Phase 24

**Status:** Phase 24 is in progress. Phase 32 will integrate when Phase 24 is
complete.

### 7.3 With Phase 31 (Long-Horizon Autonomy)

**Integration:** Phase 32 consumes Phase 31's persistent goals, bounded
scheduling and continuation.

**Contract:**
- Phase 31 produces persistent goals, bounded scheduling and continuation
- Phase 32 consumes them and produces economic experiments
- Phase 32 does not write to Phase 31

**Status:** Phase 31 is in progress. Phase 32 will integrate when Phase 31 is
complete.

---

## 8. Risk assessment

### 8.1 Phase 23 not complete

**Risk:** Phase 32 cannot consume Phase 23's wake events.

**Mitigation:** Phase 32 defines its own wake event types. When Phase 23
is complete, Phase 32 integrates its wake events.

### 8.2 Phase 24 not complete

**Risk:** Phase 32 cannot consume Phase 24's executive decisions.

**Mitigation:** Phase 32 defines its own executive decision types. When Phase 24
is complete, Phase 32 integrates its executive decisions.

### 8.3 Phase 31 not complete

**Risk:** Phase 32 cannot consume Phase 31's persistent goals.

**Mitigation:** Phase 32 defines its own goal types. When Phase 31
is complete, Phase 32 integrates its goals.

### 8.4 Concurrent development conflict

**Risk:** Phase 23, 24, or 31 changes their contracts while Phase 32 is in
development.

**Mitigation:** Phase 32 defines its own interfaces. Integration happens
only when dependencies are green.

---

## 9. Dependency resolution order

Phase 32 implementation begins when:

1. Phase 23 (Continuous Life Loop) is complete
2. Phase 24 (Executive Intelligence) is complete
3. Phase 31 (Long-Horizon Autonomy) is complete
4. All predecessor dependencies are green
5. The owner approves the integration
6. PLAN.md is updated to reflect Phase 32 readiness

Until then, Phase 32 remains a preparation-only branch.
