# Phase 31 — Dependency Map

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This dependency map defines what Phase 31 depends on and what depends on Phase 31.
It is the contract between Phase 31 and the rest of the system.

Phase 31 is a **preparation-only** branch. It does not implement production
runtime behavior. It defines the architecture, interfaces, test plans, red-team
cases and acceptance criteria for Long-Horizon Autonomy.

---

## 2. Predecessor dependencies

Phase 31 depends on these completed phases:

### 2.1 Phase 1 — Core authority

**Provides:**
- Guard (capability enforcement)
- Governor (cognition authorization)
- STOP ALL (immediate halt)
- Budgets (spend limits)
- Approvals (owner decisions)

**Phase 31 uses:**
- Guard to check capabilities before delegation
- Governor to authorize cognition requests
- STOP ALL to halt all activity
- Budgets to limit delegation spend
- Approvals to gate consequential actions

**Status:** completed

### 2.2 Phase 6 — Work execution engine

**Provides:**
- Run/Step/Action/Observation/Verification lifecycle
- Work limits and ceilings
- Approval workflow
- Capability risk taxonomy

**Phase 31 uses:**
- WorkEngine to execute bounded actions
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

**Phase 31 uses:**
- MissionEngine to track mission progress
- Mission lifecycle to prioritize work
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

**Phase 31 uses:**
- WorkforceEngine to delegate bounded work
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

**Phase 31 uses:**
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

**Phase 31 uses:**
- Life Loop to drive long-horizon decisions
- Wake source validation to ensure authorized wakes
- Pre-cognition filter to gate cognition
- Continuation state machine to manage long-horizon state transitions

**Status:** in progress (branch `prep/phase23-life-loop`)

### 2.7 Phase 24 — Executive Intelligence

**Provides:**
- Prioritization, planning, coordination and uncertainty handling
- Executive state (explainable)
- Bounded delegation
- Retry ceilings and backoff

**Phase 31 uses:**
- Executive Intelligence to prioritize long-horizon goals
- Planning to produce bounded next actions
- Coordination to delegate bounded work
- Uncertainty handling to surface assumptions and confidence

**Status:** in progress (branch `prep/phase24-executive`)

### 2.8 Phase 27-30 — Relationship II, Experience, Capability Acquisition, Self-Improving

**Provides:**
- Deeper long-term relationship understanding
- Verified outcomes become structured experience, knowledge and skills
- Autonomous capability acquisition
- Staging-branch improvement loop

**Phase 31 uses:**
- Phase 27 relationship context to inform long-horizon decisions
- Phase 28 experience/knowledge/skills to improve long-horizon planning
- Phase 29 capability acquisition to detect and fill capability gaps
- Phase 30 self-improving architecture to improve long-horizon code

**Status:** in progress (branch `prep/phase27-30`)

---

## 3. Successor dependencies

These phases depend on Phase 31:

### 3.1 Phase 32 — Economic Intelligence

**Depends on:**
- Phase 31's long-horizon autonomy to pursue multi-day/multi-week economic goals
- Phase 31's bounded scheduling to evaluate economic opportunities
- Phase 31's verification to confirm economic outcomes

**Status:** not started

### 3.2 Phase 33 — Autonomous Enterprise

**Depends on:**
- Phase 31's long-horizon autonomy to operate Webzone
- Phase 31's persistent goals to track business objectives
- Phase 31's bounded delegation to manage workforce

**Status:** not started

---

## 4. Concurrent dependencies

These phases are being developed concurrently with Phase 31:

### 4.1 Phase 23 — Continuous Life Loop

**Relationship:** Phase 31 consumes Phase 23's wake events and continuation
state. Phase 23 is an event-driven continuation system.

**Contract:** Phase 23 provides wake events and continuation state. Phase 31
consumes them and produces long-horizon decisions. Phase 31 does not write to
Phase 23.

**Status:** Phase 23 is in progress on branch `prep/phase23-life-loop`.

### 4.2 Phase 24 — Executive Intelligence

**Relationship:** Phase 31 consumes Phase 24's executive decisions and
coordination. Phase 24 is a prioritization, planning and coordination system.

**Contract:** Phase 24 provides executive decisions and coordination. Phase 31
consumes them and produces long-horizon goals. Phase 31 does not write to
Phase 24.

**Status:** Phase 24 is in progress on branch `prep/phase24-executive`.

### 4.3 Phase 27-30 — Relationship II, Experience, Capability Acquisition, Self-Improving

**Relationship:** Phase 31 consumes Phase 27-30's relationship context,
experience, capabilities and self-improvement. Phase 27-30 are concurrent
preparation branches.

**Contract:** Phase 27-30 provide relationship context, experience, capabilities
and self-improvement. Phase 31 consumes them and produces long-horizon goals.
Phase 31 does not write to Phase 27-30.

**Status:** Phase 27-30 is in progress on branch `prep/phase27-30`.

---

## 5. External dependencies

### 5.1 EventStore

**Provides:** Append-only event journal

**Phase 31 uses:** To journal long-horizon decisions, goals, checkpoints,
escalations, and red-team attempts.

**Status:** completed

### 5.2 Vault

**Provides:** Encrypted durable storage

**Phase 31 uses:** To store persistent goals, checkpoints, and long-horizon state.

**Status:** completed (canonical SQLCipher Vault on main)

### 5.3 Model Gateway

**Provides:** Provider-independent model access

**Phase 31 uses:** Phase 31 does NOT call models directly. It delegates to
Governor, which authorizes cognition requests.

**Status:** completed

---

## 6. Dependency constraints

### 6.1 Phase 31 does NOT depend on

- Phase 25 (Digital Senses & Hands II)
- Phase 26 (Natural Presence)
- Phase 32 (Economic Intelligence)
- Phase 33 (Autonomous Enterprise)

### 6.2 Phase 31 does NOT provide

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)

### 6.3 Phase 31 does NOT bypass

- Guard
- Governor
- STOP ALL
- Budgets
- Approvals

---

## 7. Integration points

### 7.1 With Phase 23 (Continuous Life Loop)

**Integration:** Phase 31 consumes Phase 23's wake events and continuation
state.

**Contract:**
- Phase 23 produces wake events with authorized sources
- Phase 31 consumes wake events and produces long-horizon decisions
- Phase 31 does not produce wake events
- Phase 31 does not modify continuation state

**Status:** Phase 23 is in progress. Phase 31 will integrate when Phase 23 is
complete.

### 7.2 With Phase 24 (Executive Intelligence)

**Integration:** Phase 31 consumes Phase 24's executive decisions and
coordination.

**Contract:**
- Phase 24 produces executive decisions and coordination
- Phase 31 consumes them and produces long-horizon goals
- Phase 31 does not write to Phase 24

**Status:** Phase 24 is in progress. Phase 31 will integrate when Phase 24 is
complete.

### 7.3 With Phase 27-30 (Relationship II, Experience, Capability Acquisition, Self-Improving)

**Integration:** Phase 31 consumes Phase 27-30's relationship context,
experience, capabilities and self-improvement.

**Contract:**
- Phase 27-30 produce relationship context, experience, capabilities and self-improvement
- Phase 31 consumes them and produces long-horizon goals
- Phase 31 does not write to Phase 27-30

**Status:** Phase 27-30 is in progress. Phase 31 will integrate when Phase 27-30 is
complete.

---

## 8. Risk assessment

### 8.1 Phase 23 not complete

**Risk:** Phase 31 cannot consume Phase 23's wake events.

**Mitigation:** Phase 31 defines its own wake event types. When Phase 23
is complete, Phase 31 integrates its wake events.

### 8.2 Phase 24 not complete

**Risk:** Phase 31 cannot consume Phase 24's executive decisions.

**Mitigation:** Phase 31 defines its own executive decision types. When Phase 24
is complete, Phase 31 integrates its executive decisions.

### 8.3 Phase 27-30 not complete

**Risk:** Phase 31 cannot consume Phase 27-30's relationship context, experience,
capabilities and self-improvement.

**Mitigation:** Phase 31 defines its own types. When Phase 27-30
is complete, Phase 31 integrates its types.

### 8.4 Concurrent development conflict

**Risk:** Phase 23, 24, or 27-30 changes their contracts while Phase 31 is in
development.

**Mitigation:** Phase 31 defines its own interfaces. Integration happens
only when dependencies are green.

---

## 9. Dependency resolution order

Phase 31 implementation begins when:

1. Phase 23 (Continuous Life Loop) is complete
2. Phase 24 (Executive Intelligence) is complete
3. Phase 27-30 (Relationship II, Experience, Capability Acquisition, Self-Improving) is complete
4. All predecessor dependencies are green
5. The owner approves the integration
6. PLAN.md is updated to reflect Phase 31 readiness

Until then, Phase 31 remains a preparation-only branch.
