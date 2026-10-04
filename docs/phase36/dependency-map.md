# Phase 36 — Dependency Map

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This dependency map defines what Phase 36 depends on and what depends on Phase 36.
It is the contract between Phase 36 and the rest of the system.

Phase 36 is a **preparation-only** branch. It does not implement production
runtime behavior. It defines the architecture, interfaces, test plans, red-team
cases and acceptance criteria for Resilience & Self-Recovery.

---

## 2. Predecessor dependencies

Phase 36 depends on these completed phases:

### 2.1 Phase 1 — Core authority

**Provides:**
- Guard (capability enforcement)
- Governor (cognition authorization)
- STOP ALL (immediate halt)
- Budgets (spend limits)
- Approvals (owner decisions)

**Phase 36 uses:**
- Guard to check capabilities before recovery/repair
- Governor to authorize cognition requests
- STOP ALL to halt all activity
- Budgets to limit recovery/repair spend
- Approvals to gate consequential repairs

**Status:** completed

### 2.2 Phase 9 — Context Awareness + Encrypted Restart Recovery

**Provides:**
- Encrypted restart recovery architecture
- Context awareness
- Encrypted state management

**Phase 36 uses:**
- Encrypted restart recovery for crash/data/provider failure recovery
- Context awareness for degraded-mode detection
- Encrypted state management for backup/restore

**Status:** completed

### 2.3 Phase 23 — Continuous Life Loop

**Provides:**
- Event-driven, bounded continuation system
- Wake source validation
- Pre-cognition filter
- Continuation state machine
- Verification deadline enforcement

**Phase 36 uses:**
- Life Loop to drive resilience decisions
- Wake source validation to ensure authorized wakes
- Pre-cognition filter to gate cognition
- Continuation state machine to manage resilience state transitions

**Status:** in progress (branch `prep/phase23-life-loop`)

### 2.4 Phase 31 — Long-Horizon Autonomy

**Provides:**
- Persistent goal semantics
- Bounded scheduling/wake rules
- Interruption/preemption
- Verification/recovery
- Restart continuity
- Uncertainty handling

**Phase 36 uses:**
- Long-Horizon Autonomy for event-sourced recovery
- Restart continuity for crash recovery
- Verification/recovery for repair verification

**Status:** in progress (branch `prep/phase31-long-horizon`)

### 2.5 Phase 33 — Autonomous Enterprise

**Provides:**
- Business environment
- Enterprise boundaries
- Task/mission orchestration
- Webzone interfaces
- Spending gates
- External-action verification
- Rollback/recovery

**Phase 36 uses:**
- Autonomous Enterprise for enterprise operation recovery
- Enterprise boundaries for recovery boundaries
- Spending gates for recovery spending limits
- Rollback/recovery for repair reversibility

**Status:** in progress (branch `prep/phase33-enterprise`)

---

## 3. Successor dependencies

These phases depend on Phase 36:

### 3.1 Phase 37 — Sovereign Intelligence

**Depends on:**
- Phase 36's resilience for provider independence
- Phase 36's backup/restore for portable encrypted identity/data
- Phase 36's degraded-mode honesty for offline/local reasoning path

**Status:** not started

### 3.2 Phase 38 — Cognitive Evolution

**Depends on:**
- Phase 36's resilience for evidence-driven improvement
- Phase 36's repair workflows for learning from failures

**Status:** not started

### 3.3 Phase 39 — Mature Freya / Jarvis Threshold

**Depends on:**
- Phase 36's resilience for crash/data/provider failure recovery
- Phase 36's backup/restore for backup/restore
- Phase 36's degraded-mode honesty for degraded-mode honesty

**Status:** not started

---

## 4. Concurrent dependencies

These phases are being developed concurrently with Phase 36:

### 4.1 Phase 23 — Continuous Life Loop

**Relationship:** Phase 36 consumes Phase 23's wake events and continuation
state. Phase 23 is an event-driven continuation system.

**Contract:** Phase 23 provides wake events and continuation state. Phase 36
consumes them and produces resilience decisions. Phase 36 does not write to
Phase 23.

**Status:** Phase 23 is in progress on branch `prep/phase23-life-loop`.

### 4.2 Phase 31 — Long-Horizon Autonomy

**Relationship:** Phase 36 consumes Phase 31's persistent goals, bounded
scheduling and continuation. Phase 31 is a long-horizon autonomy system.

**Contract:** Phase 31 provides persistent goals, bounded scheduling and
continuation. Phase 36 consumes them and produces resilience decisions. Phase 36
does not write to Phase 31.

**Status:** Phase 31 is in progress on branch `prep/phase31-long-horizon`.

### 4.3 Phase 33 — Autonomous Enterprise

**Relationship:** Phase 36 consumes Phase 33's business environment, enterprise
boundaries and rollback/recovery. Phase 33 is an autonomous enterprise system.

**Contract:** Phase 33 provides business environment, enterprise boundaries and
rollback/recovery. Phase 36 consumes them and produces resilience decisions.
Phase 36 does not write to Phase 33.

**Status:** Phase 33 is in progress on branch `prep/phase33-enterprise`.

---

## 5. External dependencies

### 5.1 EventStore

**Provides:** Append-only event journal

**Phase 36 uses:** To journal resilience decisions, failures, recoveries,
repairs, backups, restores, degraded-mode transitions, and red-team attempts.

**Status:** completed

### 5.2 Vault

**Provides:** Encrypted durable storage

**Phase 36 uses:** To store resilience state, recovery records, repair records,
backup records, and restore records.

**Status:** completed (canonical SQLCipher Vault on main)

### 5.3 Model Gateway

**Provides:** Provider-independent model access

**Phase 36 uses:** Phase 36 does NOT call models directly for deterministic
recovery. It delegates to Governor, which authorizes cognition requests.

**Status:** completed

---

## 6. Dependency constraints

### 6.1 Phase 36 does NOT depend on

- Phase 24 (Executive Intelligence)
- Phase 25 (Digital Senses & Hands II)
- Phase 26 (Natural Presence)
- Phase 27 (Relationship Intelligence II)
- Phase 28 (Experience → Knowledge → Skill)
- Phase 29 (Autonomous Capability Acquisition)
- Phase 30 (Self-Improving Architecture)
- Phase 32 (Economic Intelligence)
- Phase 34 (Multi-Device Freya — deferred)
- Phase 35 (Physical World Interface — deferred)

### 6.2 Phase 36 does NOT provide

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)
- Real-money actions (not owned by anyone — forbidden)
- Trusted runtime code (not self-modifiable)

### 6.3 Phase 36 does NOT bypass

- Guard
- Governor
- STOP ALL
- Budgets
- Approvals

### 6.4 Phase 36 does NOT self-modify

- Trusted runtime code
- Guard
- Governor
- STOP ALL
- Budgets
- Approvals

---

## 7. Integration points

### 7.1 With Phase 9 (Context Awareness + Encrypted Restart Recovery)

**Integration:** Phase 36 consumes Phase 9's encrypted restart recovery
architecture.

**Contract:**
- Phase 9 provides encrypted restart recovery
- Phase 36 consumes it and produces resilience decisions
- Phase 36 does not write to Phase 9

**Status:** Phase 9 is complete. Phase 36 integrates when Phase 36 begins.

### 7.2 With Phase 23 (Continuous Life Loop)

**Integration:** Phase 36 consumes Phase 23's wake events and continuation
state.

**Contract:**
- Phase 23 produces wake events with authorized sources
- Phase 36 consumes wake events and produces resilience decisions
- Phase 36 does not produce wake events
- Phase 36 does not modify continuation state

**Status:** Phase 23 is in progress. Phase 36 will integrate when Phase 23 is
complete.

### 7.3 With Phase 31 (Long-Horizon Autonomy)

**Integration:** Phase 36 consumes Phase 31's persistent goals, bounded
scheduling and continuation.

**Contract:**
- Phase 31 produces persistent goals, bounded scheduling and continuation
- Phase 36 consumes them and produces resilience decisions
- Phase 36 does not write to Phase 31

**Status:** Phase 31 is in progress. Phase 36 will integrate when Phase 31 is
complete.

### 7.4 With Phase 33 (Autonomous Enterprise)

**Integration:** Phase 36 consumes Phase 33's business environment, enterprise
boundaries and rollback/recovery.

**Contract:**
- Phase 33 produces business environment, enterprise boundaries and rollback/recovery
- Phase 36 consumes them and produces resilience decisions
- Phase 36 does not write to Phase 33

**Status:** Phase 33 is in progress. Phase 36 will integrate when Phase 33 is
complete.

---

## 8. Risk assessment

### 8.1 Phase 23 not complete

**Risk:** Phase 36 cannot consume Phase 23's wake events.

**Mitigation:** Phase 36 defines its own wake event types. When Phase 23
is complete, Phase 36 integrates its wake events.

### 8.2 Phase 31 not complete

**Risk:** Phase 36 cannot consume Phase 31's persistent goals.

**Mitigation:** Phase 36 defines its own goal types. When Phase 31
is complete, Phase 36 integrates its goals.

### 8.3 Phase 33 not complete

**Risk:** Phase 36 cannot consume Phase 33's business environment.

**Mitigation:** Phase 36 defines its own environment types. When Phase 33
is complete, Phase 36 integrates its environment types.

### 8.4 Concurrent development conflict

**Risk:** Phase 23, 31, or 33 changes their contracts while Phase 36 is in
development.

**Mitigation:** Phase 36 defines its own interfaces. Integration happens
only when dependencies are green.

---

## 9. Dependency resolution order

Phase 36 implementation begins when:

1. Phase 23 (Continuous Life Loop) is complete
2. Phase 31 (Long-Horizon Autonomy) is complete
3. Phase 33 (Autonomous Enterprise) is complete
4. All predecessor dependencies are green
5. The owner approves the integration
6. PLAN.md is updated to reflect Phase 36 readiness

Until then, Phase 36 remains a preparation-only branch.
