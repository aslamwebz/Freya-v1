# Phase 38 — Dependency Map

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This dependency map defines what Phase 38 depends on and what depends on Phase 38.
It is the contract between Phase 38 and the rest of the system.

Phase 38 is a **preparation-only** branch. It does not implement production
runtime behavior. It defines the architecture, interfaces, test plans, red-team
cases and acceptance criteria for Cognitive Evolution.

---

## 2. Predecessor dependencies

Phase 38 depends on these completed phases:

### 2.1 Phase 1 — Core authority

**Provides:**
- Guard (capability enforcement)
- Governor (cognition authorization)
- STOP ALL (immediate halt)
- Budgets (spend limits)
- Approvals (owner decisions)

**Phase 38 uses:**
- Guard to check capabilities before evolution operations
- Governor to authorize cognition requests
- STOP ALL to halt all activity
- Budgets to limit evolution spend
- Approvals to gate consequential improvements

**Status:** completed

### 2.2 Phase 17 — Skills, evaluation and controlled improvement

**Provides:**
- Skills architecture
- Evaluation framework
- Controlled improvement process

**Phase 38 uses:**
- Skills for learning improvement
- Evaluation for evidence verification
- Controlled improvement for staging

**Status:** completed

### 2.3 Phase 28 — Experience → Knowledge → Skill

**Provides:**
- Experience architecture
- Knowledge architecture
- Skill architecture
- Evidence-driven learning

**Phase 38 uses:**
- Experience for evidence collection
- Knowledge for improvement tracking
- Skill for learning improvement

**Status:** in progress (branch `prep/phase27-30`)

### 2.4 Phase 30 — Self-Improving Architecture

**Provides:**
- Staging-branch improvement loop
- Tests, review, rollback
- Owner-controlled merge

**Phase 38 uses:**
- Staging-branch improvement loop for evolution
- Tests, review, rollback for improvement verification
- Owner-controlled merge for improvement application

**Status:** in progress (branch `prep/phase27-30`)

### 2.5 Phase 37 — Sovereign Intelligence

**Provides:**
- Provider independence
- Offline/local reasoning
- Portable encrypted identity/data

**Phase 38 uses:**
- Provider independence for evidence-driven improvement
- Offline reasoning for learning without network
- Portable data for cross-environment learning

**Status:** in progress (branch `prep/phase37-sovereign`)

---

## 3. Successor dependencies

These phases depend on Phase 38:

### 3.1 Phase 39 — Mature Freya / Jarvis Threshold

**Depends on:**
- Phase 38's cognitive evolution for evidence-driven improvement
- Phase 38's authority drift prevention for improvement without authority drift
- Phase 38's planning/reasoning/learning improvement for mature capabilities

**Status:** not started

---

## 4. Concurrent dependencies

These phases are being developed concurrently with Phase 38:

### 4.1 Phase 28 — Experience → Knowledge → Skill

**Relationship:** Phase 38 consumes Phase 28's experience, knowledge, and skill
architecture. Phase 28 is an evidence-driven learning system.

**Contract:** Phase 28 provides experience, knowledge, and skill architecture.
Phase 38 consumes them and produces evolution decisions. Phase 38 does not write
to Phase 28.

**Status:** Phase 28 is in progress on branch `prep/phase27-30`.

### 4.2 Phase 30 — Self-Improving Architecture

**Relationship:** Phase 38 consumes Phase 30's staging-branch improvement loop.
Phase 30 is a self-improving architecture system.

**Contract:** Phase 30 provides staging-branch improvement loop. Phase 38
consumes it and produces evolution decisions. Phase 38 does not write to Phase 30.

**Status:** Phase 30 is in progress on branch `prep/phase27-30`.

### 4.3 Phase 37 — Sovereign Intelligence

**Relationship:** Phase 38 consumes Phase 37's provider independence and
offline reasoning. Phase 37 is a sovereign intelligence system.

**Contract:** Phase 37 provides provider independence and offline reasoning.
Phase 38 consumes them and produces evolution decisions. Phase 38 does not write
to Phase 37.

**Status:** Phase 37 is in progress on branch `prep/phase37-sovereign`.

---

## 5. External dependencies

### 5.1 EventStore

**Provides:** Append-only event journal

**Phase 38 uses:** To journal evolution decisions, evidence verifications,
improvements, drift checks, and red-team attempts.

**Status:** completed

### 5.2 Vault

**Provides:** Encrypted durable storage

**Phase 38 uses:** To store evolution state, evidence records, improvement
records, and drift check records.

**Status:** completed (canonical SQLCipher Vault on main)

### 5.3 Model Gateway

**Provides:** Provider-independent model access

**Phase 38 uses:** Phase 38 does NOT call models directly for deterministic
evolution. It delegates to Governor, which authorizes cognition requests.

**Status:** completed

---

## 6. Dependency constraints

### 6.1 Phase 38 does NOT depend on

- Phase 23 (Continuous Life Loop)
- Phase 24 (Executive Intelligence)
- Phase 25 (Digital Senses & Hands II)
- Phase 26 (Natural Presence)
- Phase 27 (Relationship Intelligence II)
- Phase 29 (Autonomous Capability Acquisition)
- Phase 31 (Long-Horizon Autonomy)
- Phase 32 (Economic Intelligence)
- Phase 33 (Autonomous Enterprise)
- Phase 34 (Multi-Device Freya — deferred)
- Phase 35 (Physical World Interface — deferred)
- Phase 36 (Resilience & Self-Recovery)

### 6.2 Phase 38 does NOT provide

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)
- Real-money actions (not owned by anyone — forbidden)
- Trusted runtime code (not self-modifiable)

### 6.3 Phase 38 does NOT bypass

- Guard
- Governor
- STOP ALL
- Budgets
- Approvals

### 6.4 Phase 38 does NOT self-modify

- Trusted runtime code
- Guard
- Governor
- STOP ALL
- Budgets
- Approvals

---

## 7. Integration points

### 7.1 With Phase 28 (Experience → Knowledge → Skill)

**Integration:** Phase 38 consumes Phase 28's experience, knowledge, and skill
architecture.

**Contract:**
- Phase 28 produces experience, knowledge, and skill architecture
- Phase 38 consumes them and produces evolution decisions
- Phase 38 does not write to Phase 28

**Status:** Phase 28 is in progress. Phase 38 will integrate when Phase 28 is
complete.

### 7.2 With Phase 30 (Self-Improving Architecture)

**Integration:** Phase 38 consumes Phase 30's staging-branch improvement loop.

**Contract:**
- Phase 30 produces staging-branch improvement loop
- Phase 38 consumes it and produces evolution decisions
- Phase 38 does not write to Phase 30

**Status:** Phase 30 is in progress. Phase 38 will integrate when Phase 30 is
complete.

### 7.3 With Phase 37 (Sovereign Intelligence)

**Integration:** Phase 38 consumes Phase 37's provider independence and
offline reasoning.

**Contract:**
- Phase 37 produces provider independence and offline reasoning
- Phase 38 consumes them and produces evolution decisions
- Phase 38 does not write to Phase 37

**Status:** Phase 37 is in progress. Phase 38 will integrate when Phase 37 is
complete.

---

## 8. Risk assessment

### 8.1 Phase 28 not complete

**Risk:** Phase 38 cannot consume Phase 28's experience, knowledge, and skill
architecture.

**Mitigation:** Phase 38 defines its own types. When Phase 28
is complete, Phase 38 integrates its types.

### 8.2 Phase 30 not complete

**Risk:** Phase 38 cannot consume Phase 30's staging-branch improvement loop.

**Mitigation:** Phase 38 defines its own staging types. When Phase 30
is complete, Phase 38 integrates its staging types.

### 8.3 Phase 37 not complete

**Risk:** Phase 38 cannot consume Phase 37's provider independence.

**Mitigation:** Phase 38 defines its own provider types. When Phase 37
is complete, Phase 38 integrates its provider types.

### 8.4 Concurrent development conflict

**Risk:** Phase 28, 30, or 37 changes their contracts while Phase 38 is in
development.

**Mitigation:** Phase 38 defines its own interfaces. Integration happens
only when dependencies are green.

---

## 9. Dependency resolution order

Phase 38 implementation begins when:

1. Phase 28 (Experience → Knowledge → Skill) is complete
2. Phase 30 (Self-Improving Architecture) is complete
3. Phase 37 (Sovereign Intelligence) is complete
4. All predecessor dependencies are green
5. The owner approves the integration
6. PLAN.md is updated to reflect Phase 38 readiness

Until then, Phase 38 remains a preparation-only branch.
