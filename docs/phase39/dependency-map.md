# Phase 39 — Dependency Map

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This dependency map defines what Phase 39 depends on and what depends on
Phase 39. It is the contract between Phase 39 and the rest of the system.

Phase 39 is a **preparation-only** branch. It does not implement production
runtime behavior. It defines the architecture, interfaces, test plans,
red-team cases, acceptance criteria, maturity criteria, fail-closed
conditions, evidence requirements, rollback criteria and dependency map for
the Mature Freya Threshold.

**Phase 39 is a threshold to prove — not a license to widen authority.**

---

## 2. Predecessor dependencies

Phase 39 depends on these completed phases:

### 2.1 Phase 1 — Core authority

**Provides:**
- Guard (capability enforcement)
- Governor (cognition authorization)
- STOP ALL (immediate halt)
- Budgets (spend limits)
- Approvals (owner decisions)

**Phase 39 uses:**
- Guard to check capabilities before threshold operations
- Governor to authorize cognition requests
- STOP ALL to halt all activity
- Budgets to limit threshold spend
- Approvals to gate consequential threshold decisions

**Status:** completed

### 2.2 Phase 4 — Brain: identity, admitted memory and continuity

**Provides:**
- Identity architecture
- Admitted memory architecture
- Continuity architecture

**Phase 39 uses:**
- Identity for self-model maturity assessment
- Admitted memory for memory maturity assessment
- Continuity for long-horizon behavior maturity assessment

**Status:** completed

### 2.3 Phase 5 — Research: search, managed browser and cited evidence

**Provides:**
- Research architecture
- Cited evidence architecture

**Phase 39 uses:**
- Research for economic boundaries maturity assessment
- Cited evidence for evidence requirements

**Status:** completed

### 2.4 Phase 7 — Missions: persistent verified outcomes

**Provides:**
- Mission architecture
- Verified outcomes architecture

**Phase 39 uses:**
- Missions for long-horizon behavior maturity assessment
- Verified outcomes for verification maturity assessment

**Status:** completed

### 2.5 Phase 8 — Workforce: bounded subordinate agents

**Provides:**
- Workforce architecture
- Bounded subordinate agents

**Phase 39 uses:**
- Workforce for autonomy maturity assessment
- Bounded agents for owner control maturity assessment

**Status:** completed

### 2.6 Phase 9 — Context Awareness + encrypted restart recovery

**Provides:**
- Context awareness architecture
- Encrypted restart recovery

**Phase 39 uses:**
- Context awareness for memory maturity assessment
- Encrypted restart recovery for recovery maturity assessment

**Status:** completed

### 2.7 Phase 11 — Personality and Relationship

**Provides:**
- Personality architecture
- Relationship architecture

**Phase 39 uses:**
- Personality for world/self model maturity assessment
- Relationship for relationship intelligence maturity assessment

**Status:** completed

### 2.8 Phase 16 — Relay

**Provides:**
- Relay architecture
- Approval/idempotency state

**Phase 39 uses:**
- Relay for owner control maturity assessment
- Approval state for approval enforcement

**Status:** completed

### 2.9 Phase 17 — Skills, evaluation and controlled improvement

**Provides:**
- Skills architecture
- Evaluation framework
- Controlled improvement process

**Phase 39 uses:**
- Skills for capability acquisition maturity assessment
- Evaluation for self-improvement maturity assessment
- Controlled improvement for self-improvement maturity assessment

**Status:** completed

### 2.10 Phase 18 — Integration, security and packaging hardening

**Provides:**
- Security hardening
- Packaging hardening
- Integration patterns

**Phase 39 uses:**
- Security hardening for security maturity assessment
- Packaging hardening for recovery maturity assessment

**Status:** completed

### 2.11 Phase 21 — Deep Memory & Life History

**Provides:**
- Deep memory architecture
- Life history architecture
- Autobiographical continuity

**Phase 39 uses:**
- Deep memory for memory maturity assessment
- Life history for long-horizon behavior maturity assessment

**Status:** in progress (branch `prep/phase19-22`)

### 2.12 Phase 22 — Self & World Model II

**Provides:**
- Self model architecture
- World model architecture
- Evidenced graph with provenance

**Phase 39 uses:**
- Self model for world/self model maturity assessment
- World model for world/self model maturity assessment
- Evidenced graph for evidence requirements

**Status:** in progress (branch `prep/phase19-22`)

### 2.13 Phase 23 — Continuous Life Loop

**Provides:**
- Continuous life loop architecture
- Event/heartbeat wake loop

**Phase 39 uses:**
- Continuous life loop for autonomy maturity assessment
- Event/heartbeat wake for long-horizon behavior maturity assessment

**Status:** in progress (branch `prep/phase19-22`)

### 2.14 Phase 24 — Executive Intelligence

**Provides:**
- Prioritization architecture
- Planning architecture
- Coordination architecture
- Uncertainty handling

**Phase 39 uses:**
- Prioritization for autonomy maturity assessment
- Planning for long-horizon behavior maturity assessment
- Uncertainty handling for verification maturity assessment

**Status:** in progress (branch `prep/phase19-22`)

### 2.15 Phase 25 — Digital Senses & Hands II

**Provides:**
- Browser capability
- Terminal capability
- Clipboard capability
- Download/upload capability

**Phase 39 uses:**
- Digital hands for capability acquisition maturity assessment
- Bounded capabilities for autonomy maturity assessment

**Status:** in progress (branch `prep/phase19-22`)

### 2.16 Phase 27 — Relationship Intelligence II

**Provides:**
- Deeper relationship understanding
- Provenance-carrying relationship data
- Anti-dependence safeguards

**Phase 39 uses:**
- Relationship intelligence for relationship intelligence maturity assessment
- Anti-dependence safeguards for relationship intelligence maturity assessment

**Status:** in progress (branch `prep/phase27-30`)

### 2.17 Phase 28 — Experience → Knowledge → Skill

**Provides:**
- Experience architecture
- Knowledge architecture
- Skill architecture
- Evidence-driven learning

**Phase 39 uses:**
- Experience for self-improvement maturity assessment
- Knowledge for self-improvement maturity assessment
- Skill for capability acquisition maturity assessment

**Status:** in progress (branch `prep/phase27-30`)

### 2.18 Phase 29 — Autonomous Capability Acquisition

**Provides:**
- Capability gap detection
- Propose/build/verify flow
- Gated activation

**Phase 39 uses:**
- Capability acquisition for capability acquisition maturity assessment
- Gated activation for capability acquisition maturity assessment

**Status:** in progress (branch `prep/phase27-30`)

### 2.19 Phase 30 — Self-Improving Architecture

**Provides:**
- Staging-branch improvement loop
- Tests, review, rollback
- Owner-controlled merge

**Phase 39 uses:**
- Staging-branch improvement loop for self-improvement maturity assessment
- Owner-controlled merge for self-improvement maturity assessment

**Status:** in progress (branch `prep/phase27-30`)

### 2.20 Phase 31 — Long-Horizon Autonomy

**Provides:**
- Multi-day/multi-week goal continuation
- Event-driven continuation
- Interruption reconciliation

**Phase 39 uses:**
- Long-horizon autonomy for long-horizon behavior maturity assessment
- Event-driven continuation for long-horizon behavior maturity assessment

**Status:** in progress (branch `prep/phase31-33`)

### 2.21 Phase 32 — Economic Intelligence

**Provides:**
- Research engine
- Simulation engine
- Paper trading
- Measured economic evidence

**Phase 39 uses:**
- Economic intelligence for economic boundaries maturity assessment
- Paper trading for economic boundaries maturity assessment

**Status:** in progress (branch `prep/phase31-33`)

### 2.22 Phase 33 — Autonomous Enterprise

**Provides:**
- Webzone architecture
- Enterprise boundaries
- Spending gates
- External action verification

**Phase 39 uses:**
- Enterprise for economic boundaries maturity assessment
- Spending gates for economic boundaries maturity assessment
- External action verification for verification maturity assessment

**Status:** in progress (branch `prep/phase31-33`)

### 2.23 Phase 36 — Resilience & Self-Recovery

**Provides:**
- Crash recovery
- Data failure recovery
- Provider failure recovery
- Backup restore
- Degraded-mode honesty
- Repair workflows

**Phase 39 uses:**
- Resilience for resilience maturity assessment
- Recovery for recovery maturity assessment
- Degraded-mode honesty for resilience maturity assessment

**Status:** in progress (branch `prep/phase36-resilience`)

### 2.24 Phase 37 — Sovereign Intelligence

**Provides:**
- Provider independence
- Offline/local reasoning
- Portable encrypted identity/data

**Phase 39 uses:**
- Provider independence for security maturity assessment
- Portable encrypted data for privacy maturity assessment

**Status:** in progress (branch `prep/phase37-sovereign`)

### 2.25 Phase 38 — Cognitive Evolution

**Provides:**
- Evidence-driven improvement
- Authority drift prevention
- Planning/reasoning/learning improvement

**Phase 39 uses:**
- Cognitive evolution for self-improvement maturity assessment
- Authority drift prevention for security maturity assessment

**Status:** in progress (branch `prep/phase38-cognitive-evolution`)

---

## 3. Successor dependencies

These phases depend on Phase 39:

### 3.1 No successor phases

Phase 39 is the culmination gate of Freya Lane 3. No phases depend on Phase 39
within the current plan. Phase 39 proves maturity; it does not enable new
phases.

**Status:** Phase 39 is the terminal phase of Lane 3.

---

## 4. Concurrent dependencies

These phases are being developed concurrently with Phase 39:

### 4.1 Phase 21 — Deep Memory & Life History

**Relationship:** Phase 39 consumes Phase 21's deep memory and life history
architecture. Phase 21 is a memory system.

**Contract:** Phase 21 provides deep memory and life history architecture.
Phase 39 consumes them and produces maturity assessments. Phase 39 does not
write to Phase 21.

**Status:** Phase 21 is in progress on branch `prep/phase19-22`.

### 4.2 Phase 22 — Self & World Model II

**Relationship:** Phase 39 consumes Phase 22's self and world model
architecture. Phase 22 is a self/world model system.

**Contract:** Phase 22 provides self and world model architecture. Phase 39
consumes them and produces maturity assessments. Phase 39 does not write to
Phase 22.

**Status:** Phase 22 is in progress on branch `prep/phase19-22`.

### 4.3 Phase 23 — Continuous Life Loop

**Relationship:** Phase 39 consumes Phase 23's continuous life loop
architecture. Phase 23 is a life loop system.

**Contract:** Phase 23 provides continuous life loop architecture. Phase 39
consumes them and produces maturity assessments. Phase 39 does not write to
Phase 23.

**Status:** Phase 23 is in progress on branch `prep/phase19-22`.

### 4.4 Phase 24 — Executive Intelligence

**Relationship:** Phase 39 consumes Phase 24's executive intelligence
architecture. Phase 24 is an executive intelligence system.

**Contract:** Phase 24 provides executive intelligence architecture. Phase 39
consumes them and produces maturity assessments. Phase 39 does not write to
Phase 24.

**Status:** Phase 24 is in progress on branch `prep/phase19-22`.

### 4.5 Phase 25 — Digital Senses & Hands II

**Relationship:** Phase 39 consumes Phase 25's digital senses and hands
architecture. Phase 25 is a capability system.

**Contract:** Phase 25 provides digital senses and hands architecture.
Phase 39 consumes them and produces maturity assessments. Phase 39 does not
write to Phase 25.

**Status:** Phase 25 is in progress on branch `prep/phase19-22`.

### 4.6 Phase 27 — Relationship Intelligence II

**Relationship:** Phase 39 consumes Phase 27's relationship intelligence
architecture. Phase 27 is a relationship intelligence system.

**Contract:** Phase 27 provides relationship intelligence architecture.
Phase 39 consumes them and produces maturity assessments. Phase 39 does not
write to Phase 27.

**Status:** Phase 27 is in progress on branch `prep/phase27-30`.

### 4.7 Phase 28 — Experience → Knowledge → Skill

**Relationship:** Phase 39 consumes Phase 28's experience, knowledge, and
skill architecture. Phase 28 is an evidence-driven learning system.

**Contract:** Phase 28 provides experience, knowledge, and skill architecture.
Phase 39 consumes them and produces maturity assessments. Phase 39 does not
write to Phase 28.

**Status:** Phase 28 is in progress on branch `prep/phase27-30`.

### 4.8 Phase 29 — Autonomous Capability Acquisition

**Relationship:** Phase 39 consumes Phase 29's capability acquisition
architecture. Phase 29 is a capability acquisition system.

**Contract:** Phase 29 provides capability acquisition architecture. Phase 39
consumes them and produces maturity assessments. Phase 39 does not write to
Phase 29.

**Status:** Phase 29 is in progress on branch `prep/phase27-30`.

### 4.9 Phase 30 — Self-Improving Architecture

**Relationship:** Phase 39 consumes Phase 30's self-improving architecture.
Phase 30 is a self-improving architecture system.

**Contract:** Phase 30 provides self-improving architecture. Phase 39 consumes
them and produces maturity assessments. Phase 39 does not write to Phase 30.

**Status:** Phase 30 is in progress on branch `prep/phase27-30`.

### 4.10 Phase 31 — Long-Horizon Autonomy

**Relationship:** Phase 39 consumes Phase 31's long-horizon autonomy
architecture. Phase 31 is a long-horizon autonomy system.

**Contract:** Phase 31 provides long-horizon autonomy architecture. Phase 39
consumes them and produces maturity assessments. Phase 39 does not write to
Phase 31.

**Status:** Phase 31 is in progress on branch `prep/phase31-33`.

### 4.11 Phase 32 — Economic Intelligence

**Relationship:** Phase 39 consumes Phase 32's economic intelligence
architecture. Phase 32 is an economic intelligence system.

**Contract:** Phase 32 provides economic intelligence architecture. Phase 39
consumes them and produces maturity assessments. Phase 39 does not write to
Phase 32.

**Status:** Phase 32 is in progress on branch `prep/phase31-33`.

### 4.12 Phase 33 — Autonomous Enterprise

**Relationship:** Phase 39 consumes Phase 33's autonomous enterprise
architecture. Phase 33 is an autonomous enterprise system.

**Contract:** Phase 33 provides autonomous enterprise architecture. Phase 39
consumes them and produces maturity assessments. Phase 39 does not write to
Phase 33.

**Status:** Phase 33 is in progress on branch `prep/phase31-33`.

### 4.13 Phase 36 — Resilience & Self-Recovery

**Relationship:** Phase 39 consumes Phase 36's resilience and self-recovery
architecture. Phase 36 is a resilience system.

**Contract:** Phase 36 provides resilience and self-recovery architecture.
Phase 39 consumes them and produces maturity assessments. Phase 39 does not
write to Phase 36.

**Status:** Phase 36 is in progress on branch `prep/phase36-resilience`.

### 4.14 Phase 37 — Sovereign Intelligence

**Relationship:** Phase 39 consumes Phase 37's sovereign intelligence
architecture. Phase 37 is a sovereign intelligence system.

**Contract:** Phase 37 provides sovereign intelligence architecture. Phase 39
consumes them and produces maturity assessments. Phase 39 does not write to
Phase 37.

**Status:** Phase 37 is in progress on branch `prep/phase37-sovereign`.

### 4.15 Phase 38 — Cognitive Evolution

**Relationship:** Phase 39 consumes Phase 38's cognitive evolution
architecture. Phase 38 is a cognitive evolution system.

**Contract:** Phase 38 provides cognitive evolution architecture. Phase 39
consumes them and produces maturity assessments. Phase 39 does not write to
Phase 38.

**Status:** Phase 38 is in progress on branch `prep/phase38-cognitive-evolution`.

---

## 5. External dependencies

### 5.1 EventStore

**Provides:** Append-only event journal

**Phase 39 uses:** To journal threshold decisions, evidence verifications,
assessments, fail-closed decisions, rollbacks, and red-team attempts.

**Status:** completed

### 5.2 Vault

**Provides:** Encrypted durable storage

**Phase 39 uses:** To store threshold state, evidence records, assessment
records, fail-closed records, and rollback records.

**Status:** completed (canonical SQLCipher Vault on main)

### 5.3 Model Gateway

**Provides:** Provider-independent model access

**Phase 39 uses:** Phase 39 does NOT call models directly for deterministic
assessment. It delegates to Governor, which authorizes cognition requests.

**Status:** completed

---

## 6. Dependency constraints

### 6.1 Phase 39 does NOT depend on

- Phase 0 (Desktop shell)
- Phase 2 (Command Center)
- Phase 3 (Mind)
- Phase 6 (Work execution engine)
- Phase 10 (Harness and Computer Hands)
- Phase 12 (Events and Attention)
- Phase 13 (Desktop Presence)
- Phase 14 (Office projection)
- Phase 15 (Foundry)
- Phase 19 (UI / Presence / App Mode)
- Phase 20 (Unified Conscious Context)
- Phase 26 (Natural Presence)
- Phase 34 (Multi-Device Freya — deferred)
- Phase 35 (Physical World Interface — deferred)

### 6.2 Phase 39 does NOT provide

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)
- Real-money actions (not owned by anyone — forbidden)
- Trusted runtime code (not self-modifiable)
- Maturity grants (not self-grantable)

### 6.3 Phase 39 does NOT bypass

- Guard
- Governor
- STOP ALL
- Budgets
- Approvals

### 6.4 Phase 39 does NOT self-modify

- Trusted runtime code
- Guard
- Governor
- STOP ALL
- Budgets
- Approvals

### 6.5 Phase 39 does NOT widen authority

- Phase 39 is a threshold to prove — not a license to widen authority
- Maturity does not widen authority
- Maturity is proven, not declared
- Maturity is owner-controlled
- Maturity is fail-closed

---

## 7. Integration points

### 7.1 With Phase 31 (Long-Horizon Autonomy)

**Integration:** Phase 39 consumes Phase 31's long-horizon autonomy
architecture.

**Contract:**
- Phase 31 produces long-horizon autonomy architecture
- Phase 39 consumes them and produces maturity assessments
- Phase 39 does not write to Phase 31

**Status:** Phase 31 is in progress. Phase 39 will integrate when Phase 31 is
complete.

### 7.2 With Phase 32 (Economic Intelligence)

**Integration:** Phase 39 consumes Phase 32's economic intelligence
architecture.

**Contract:**
- Phase 32 produces economic intelligence architecture
- Phase 39 consumes them and produces maturity assessments
- Phase 39 does not write to Phase 32

**Status:** Phase 32 is in progress. Phase 39 will integrate when Phase 32 is
complete.

### 7.3 With Phase 33 (Autonomous Enterprise)

**Integration:** Phase 39 consumes Phase 33's autonomous enterprise
architecture.

**Contract:**
- Phase 33 produces autonomous enterprise architecture
- Phase 39 consumes them and produces maturity assessments
- Phase 39 does not write to Phase 33

**Status:** Phase 33 is in progress. Phase 39 will integrate when Phase 33 is
complete.

### 7.4 With Phase 36 (Resilience & Self-Recovery)

**Integration:** Phase 39 consumes Phase 36's resilience and self-recovery
architecture.

**Contract:**
- Phase 36 produces resilience and self-recovery architecture
- Phase 39 consumes them and produces maturity assessments
- Phase 39 does not write to Phase 36

**Status:** Phase 36 is in progress. Phase 39 will integrate when Phase 36 is
complete.

### 7.5 With Phase 37 (Sovereign Intelligence)

**Integration:** Phase 39 consumes Phase 37's sovereign intelligence
architecture.

**Contract:**
- Phase 37 produces sovereign intelligence architecture
- Phase 39 consumes them and produces maturity assessments
- Phase 39 does not write to Phase 37

**Status:** Phase 37 is in progress. Phase 39 will integrate when Phase 37 is
complete.

### 7.6 With Phase 38 (Cognitive Evolution)

**Integration:** Phase 39 consumes Phase 38's cognitive evolution
architecture.

**Contract:**
- Phase 38 produces cognitive evolution architecture
- Phase 39 consumes them and produces maturity assessments
- Phase 39 does not write to Phase 38

**Status:** Phase 38 is in progress. Phase 39 will integrate when Phase 38 is
complete.

---

## 8. Risk assessment

### 8.1 Predecessor phases not complete

**Risk:** Phase 39 cannot consume predecessor phase architectures.

**Mitigation:** Phase 39 defines its own types. When predecessor phases are
complete, Phase 39 integrates their types.

### 8.2 Concurrent development conflict

**Risk:** Predecessor phases change their contracts while Phase 39 is in
development.

**Mitigation:** Phase 39 defines its own interfaces. Integration happens
only when dependencies are green.

### 8.3 Maturity forgery

**Risk:** An attacker attempts to forge maturity.

**Mitigation:** Maturity requires verified evidence. No evidence, no maturity.
Red-team cases test maturity forgery.

### 8.4 Authority widening through maturity

**Risk:** An attacker attempts to use maturity to widen authority.

**Mitigation:** Maturity does not widen authority. This is a core invariant.
Red-team cases test authority widening through maturity.

---

## 9. Dependency resolution order

Phase 39 implementation begins when:

1. Phase 21 (Deep Memory & Life History) is complete
2. Phase 22 (Self & World Model II) is complete
3. Phase 23 (Continuous Life Loop) is complete
4. Phase 24 (Executive Intelligence) is complete
5. Phase 25 (Digital Senses & Hands II) is complete
6. Phase 27 (Relationship Intelligence II) is complete
7. Phase 28 (Experience → Knowledge → Skill) is complete
8. Phase 29 (Autonomous Capability Acquisition) is complete
9. Phase 30 (Self-Improving Architecture) is complete
10. Phase 31 (Long-Horizon Autonomy) is complete
11. Phase 32 (Economic Intelligence) is complete
12. Phase 33 (Autonomous Enterprise) is complete
13. Phase 36 (Resilience & Self-Recovery) is complete
14. Phase 37 (Sovereign Intelligence) is complete
15. Phase 38 (Cognitive Evolution) is complete
16. All predecessor dependencies are green
17. The owner approves the integration
18. PLAN.md is updated to reflect Phase 39 readiness

Until then, Phase 39 remains a preparation-only branch.
