# Phase 25 — Dependency Map

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This dependency map defines what Phase 25 depends on and what depends on Phase 25.
It is the contract between Phase 25 and the rest of the system.

Phase 25 is a **preparation-only** branch. It does not implement production
runtime behavior. It defines the architecture, interfaces, test plans, red-team
cases and acceptance criteria for Digital Senses & Hands II.

---

## 2. Predecessor dependencies

Phase 25 depends on these completed phases:

### 2.1 Phase 1 — Core authority

**Provides:**
- Guard (capability enforcement)
- Governor (cognition authorization)
- STOP ALL (immediate halt)
- Budgets (spend limits)
- Approvals (owner decisions)

**Phase 25 uses:**
- Guard to check capabilities before execution
- Governor to authorize cognition requests
- STOP ALL to halt all activity
- Budgets to limit action spend
- Approvals to gate consequential actions

**Status:** completed

### 2.2 Phase 10 — Harness and Computer Hands foundation

**Provides:**
- Hands domain types and closed tables
- Action → Observation → Verification lifecycle
- Refusal codes for failure modes
- Validation with exact-key checking
- State management with pure functions

**Phase 25 uses:**
- Hands domain types as the foundation for new capabilities
- Action lifecycle as the execution model
- Refusal codes as the failure model
- Validation as the input boundary
- State management as the state model

**Status:** completed

### 2.3 Phase 24 — Executive Intelligence

**Provides:**
- Prioritization of work items
- Planning under uncertainty
- Coordination of bounded work
- Explainable executive state

**Phase 25 uses:**
- Executive decisions to know what actions to execute
- Coordination decisions to know what to delegate
- Executive state to know what to show

**Status:** in progress (branch `prep/phase24-executive`)

---

## 3. Successor dependencies

These phases depend on Phase 25:

### 3.1 Phase 26 — Natural Presence

**Depends on:**
- Phase 25's capability execution to know what actions are available
- Phase 25's action results to know what happened
- Phase 25's verification results to know what worked

**Status:** not started

### 3.2 Phase 27 — Relationship Intelligence II

**Depends on:**
- Phase 25's capability usage patterns to understand interaction patterns
- Phase 25's action outcomes to understand what worked

**Status:** not started

### 3.3 Phase 28 — Experience → Knowledge → Skill

**Depends on:**
- Phase 25's action outcomes to know what was learned
- Phase 25's verification results to know what worked

**Status:** not started

### 3.4 Phase 29 — Autonomous Capability Acquisition

**Depends on:**
- Phase 25's capability registry to know what capabilities exist
- Phase 25's capability gaps to know what to acquire

**Status:** not started

---

## 4. Concurrent dependencies

These phases are being developed concurrently with Phase 25:

### 4.1 Phase 24 — Executive Intelligence

**Relationship:** Phase 25 consumes Phase 24's executive decisions to know
what actions to execute.

**Contract:** Phase 24 produces executive decisions. Phase 25 consumes them
and executes bounded actions. Phase 25 does not produce executive decisions.

**Status:** Phase 24 is in progress on branch `prep/phase24-executive`.

### 4.2 Phase 23 — Continuous Life Loop

**Relationship:** Phase 25 consumes Phase 23's wake events to know when to
execute actions.

**Contract:** Phase 23 produces wake events. Phase 25 consumes them and
executes bounded actions. Phase 25 does not produce wake events.

**Status:** Phase 23 is in progress on branch `prep/phase23-life-loop`.

---

## 5. External dependencies

### 5.1 EventStore

**Provides:** Append-only event journal

**Phase 25 uses:** To journal capability actions, observations, verifications,
and refusals.

**Status:** completed

### 5.2 Vault

**Provides:** Encrypted durable storage

**Phase 25 uses:** To store capability state (derived, not durable).

**Status:** completed (canonical SQLCipher Vault on main)

### 5.3 Model Gateway

**Provides:** Provider-independent model access

**Phase 25 uses:** Phase 25 does NOT call models directly. It delegates to
Governor, which authorizes cognition requests.

**Status:** completed

---

## 6. Dependency constraints

### 6.1 Phase 25 does NOT depend on

- Phase 26 (Natural Presence)
- Phase 27 (Relationship Intelligence II)
- Phase 28 (Experience → Knowledge → Skill)
- Phase 29 (Autonomous Capability Acquisition)

### 6.2 Phase 25 does NOT provide

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)

### 6.3 Phase 25 does NOT bypass

- Guard
- Governor
- STOP ALL
- Budgets
- Approvals

---

## 7. Integration points

### 7.1 With Phase 24 (Executive Intelligence)

**Integration:** Phase 25 consumes Phase 24's executive decisions to know
what actions to execute.

**Contract:**
- Phase 24 produces executive decisions with bounded actions
- Phase 25 consumes them and executes bounded actions
- Phase 25 does not produce executive decisions
- Phase 25 does not modify executive state

**Status:** Phase 24 is in progress. Phase 25 will integrate when Phase 24 is
complete.

### 7.2 With Phase 23 (Continuous Life Loop)

**Integration:** Phase 25 consumes Phase 23's wake events to know when to
execute actions.

**Contract:**
- Phase 23 produces wake events with authorized sources
- Phase 25 consumes them and executes bounded actions
- Phase 25 does not produce wake events
- Phase 25 does not modify continuation state

**Status:** Phase 23 is in progress. Phase 25 will integrate when Phase 23 is
complete.

### 7.3 With Phase 10 (Hands foundation)

**Integration:** Phase 25 builds on Phase 10's Hands domain types and
lifecycle.

**Contract:**
- Phase 10 provides the Hands domain types and lifecycle
- Phase 25 adds new capability kinds and actions
- Phase 25 does not modify Phase 10's types or lifecycle

**Status:** Phase 10 is complete. Phase 25 builds on it.

---

## 8. Risk assessment

### 8.1 Phase 24 not complete

**Risk:** Phase 25 cannot consume Phase 24's executive decisions.

**Mitigation:** Phase 25 defines its own action types. When Phase 24 is
complete, Phase 25 integrates its executive decisions.

### 8.2 Phase 23 not complete

**Risk:** Phase 25 cannot consume Phase 23's wake events.

**Mitigation:** Phase 25 defines its own wake event types. When Phase 23 is
complete, Phase 25 integrates its wake events.

### 8.3 Concurrent development conflict

**Risk:** Phase 23 or 24 changes their contracts while Phase 25 is in
development.

**Mitigation:** Phase 25 defines its own interfaces. Integration happens
only when dependencies are green.

### 8.4 Capability expansion scope creep

**Risk:** Phase 25 expands capabilities beyond the PLAN.md boundary.

**Mitigation:** Phase 25 is bounded by PLAN.md. Any capability expansion
requires a PLAN.md update.

---

## 9. Dependency resolution order

Phase 25 implementation begins when:

1. Phase 24 (Executive Intelligence) is complete
2. Phase 23 (Continuous Life Loop) is complete
3. All predecessor dependencies are green
4. The owner approves the Electron alpha
5. PLAN.md Step G is satisfied

Until then, Phase 25 remains a preparation-only branch.
