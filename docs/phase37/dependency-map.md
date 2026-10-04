# Phase 37 — Dependency Map

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This dependency map defines what Phase 37 depends on and what depends on Phase 37.
It is the contract between Phase 37 and the rest of the system.

Phase 37 is a **preparation-only** branch. It does not implement production
runtime behavior. It defines the architecture, interfaces, test plans, red-team
cases and acceptance criteria for Sovereign Intelligence.

---

## 2. Predecessor dependencies

Phase 37 depends on these completed phases:

### 2.1 Phase 1 — Core authority

**Provides:**
- Guard (capability enforcement)
- Governor (cognition authorization)
- STOP ALL (immediate halt)
- Budgets (spend limits)
- Approvals (owner decisions)

**Phase 37 uses:**
- Guard to check capabilities before sovereignty operations
- Governor to authorize cognition requests
- STOP ALL to halt all activity
- Budgets to limit sovereignty spend
- Approvals to gate consequential actions

**Status:** completed

### 2.2 Phase 9 — Context Awareness + Encrypted Restart Recovery

**Provides:**
- Encrypted restart recovery architecture
- Context awareness
- Encrypted state management

**Phase 37 uses:**
- Encrypted restart recovery for portable encrypted data
- Context awareness for provider routing
- Encrypted state management for sovereignty state

**Status:** completed

### 2.3 Phase 36 — Resilience & Self-Recovery

**Provides:**
- Crash recovery
- Data failure recovery
- Provider failure recovery
- Backup restore
- Degraded-mode honesty
- Repair workflows

**Phase 37 uses:**
- Resilience for provider failure recovery
- Provider failure recovery for provider independence
- Degraded-mode honesty for offline reasoning
- Backup restore for portable data

**Status:** in progress (branch `prep/phase36-resilience`)

---

## 3. Successor dependencies

These phases depend on Phase 37:

### 3.1 Phase 38 — Cognitive Evolution

**Depends on:**
- Phase 37's provider independence for evidence-driven improvement
- Phase 37's offline reasoning for learning without network
- Phase 37's portable data for cross-environment learning

**Status:** not started

### 3.2 Phase 39 — Mature Freya / Jarvis Threshold

**Depends on:**
- Phase 37's provider independence for provider-independent reasoning
- Phase 37's offline reasoning for offline capability
- Phase 37's portable data for portable identity/data

**Status:** not started

---

## 4. Concurrent dependencies

These phases are being developed concurrently with Phase 37:

### 4.1 Phase 36 — Resilience & Self-Recovery

**Relationship:** Phase 37 consumes Phase 36's provider failure recovery and
degraded-mode honesty. Phase 36 is a resilience and self-recovery system.

**Contract:** Phase 36 provides provider failure recovery and degraded-mode
honesty. Phase 37 consumes them and produces sovereignty decisions. Phase 37
does not write to Phase 36.

**Status:** Phase 36 is in progress on branch `prep/phase36-resilience`.

---

## 5. External dependencies

### 5.1 EventStore

**Provides:** Append-only event journal

**Phase 37 uses:** To journal sovereignty decisions, provider routing,
offline transitions, portable data operations, and red-team attempts.

**Status:** completed

### 5.2 Vault

**Provides:** Encrypted durable storage

**Phase 37 uses:** To store sovereignty state, provider state, offline state,
and portable data records.

**Status:** completed (canonical SQLCipher Vault on main)

### 5.3 Model Gateway

**Provides:** Provider-independent model access

**Phase 37 uses:** Phase 37 extends the Model Gateway with explicit provider
routing, fallback, and offline reasoning.

**Status:** completed

---

## 6. Dependency constraints

### 6.1 Phase 37 does NOT depend on

- Phase 23 (Continuous Life Loop)
- Phase 24 (Executive Intelligence)
- Phase 25 (Digital Senses & Hands II)
- Phase 26 (Natural Presence)
- Phase 27 (Relationship Intelligence II)
- Phase 28 (Experience → Knowledge → Skill)
- Phase 29 (Autonomous Capability Acquisition)
- Phase 30 (Self-Improving Architecture)
- Phase 31 (Long-Horizon Autonomy)
- Phase 32 (Economic Intelligence)
- Phase 33 (Autonomous Enterprise)
- Phase 34 (Multi-Device Freya — deferred)
- Phase 35 (Physical World Interface — deferred)

### 6.2 Phase 37 does NOT provide

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)
- Real-money actions (not owned by anyone — forbidden)
- Trusted runtime code (not self-modifiable)

### 6.3 Phase 37 does NOT bypass

- Guard
- Governor
- STOP ALL
- Budgets
- Approvals

### 6.4 Phase 37 does NOT self-modify

- Trusted runtime code
- Guard
- Governor
- STOP ALL
- Budgets
- Approvals

---

## 7. Integration points

### 7.1 With Phase 9 (Context Awareness + Encrypted Restart Recovery)

**Integration:** Phase 37 consumes Phase 9's encrypted restart recovery
architecture.

**Contract:**
- Phase 9 provides encrypted restart recovery
- Phase 37 consumes it and produces sovereignty decisions
- Phase 37 does not write to Phase 9

**Status:** Phase 9 is complete. Phase 37 integrates when Phase 37 begins.

### 7.2 With Phase 36 (Resilience & Self-Recovery)

**Integration:** Phase 37 consumes Phase 36's provider failure recovery and
degraded-mode honesty.

**Contract:**
- Phase 36 produces provider failure recovery and degraded-mode honesty
- Phase 37 consumes them and produces sovereignty decisions
- Phase 37 does not write to Phase 36

**Status:** Phase 36 is in progress. Phase 37 will integrate when Phase 36 is
complete.

---

## 8. Risk assessment

### 8.1 Phase 36 not complete

**Risk:** Phase 37 cannot consume Phase 36's provider failure recovery.

**Mitigation:** Phase 37 defines its own provider failure recovery types. When
Phase 36 is complete, Phase 37 integrates its provider failure recovery.

### 8.2 Concurrent development conflict

**Risk:** Phase 36 changes their contracts while Phase 37 is in
development.

**Mitigation:** Phase 37 defines its own interfaces. Integration happens
only when dependencies are green.

---

## 9. Dependency resolution order

Phase 37 implementation begins when:

1. Phase 36 (Resilience & Self-Recovery) is complete
2. All predecessor dependencies are green
3. The owner approves the integration
4. PLAN.md is updated to reflect Phase 37 readiness

Until then, Phase 37 remains a preparation-only branch.
