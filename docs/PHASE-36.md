# Phase 36 — Resilience & Self-Recovery

**Status:** PREPARATION ONLY — NOT PRODUCTION  
**Branch:** `prep/phase36-resilience`  
**Blocked on:** Phase 33 and earlier integrations green  
**Required outcome:** bounded crash/data/provider failure recovery, backup restore, degraded-mode honesty and repair workflows — no hidden self-modification, no authority widening

---

## 1. What this document is

This is a **preparation specification** for Phase 36. It defines the architecture,
interfaces, crash/data/provider failure recovery, backup restore, degraded-mode
honesty, repair workflows, test plans, red-team cases and acceptance criteria
for Resilience & Self-Recovery. It does **not** implement production runtime
behavior.

**Phase 36 cannot start until Phase 33 and earlier integrations are green.**
This branch exists so that when the gate passes, implementation can begin
immediately without re-deriving the design.

---

## 2. The core invariant

> **Resilience is bounded recovery, not continuous self-repair. Every recovery
> is authorized, auditable, and reversible. No hidden self-modification, no
> authority widening, no autonomous real-money actions.**

Resilience & Self-Recovery extends the existing event-sourced recovery
architecture (Phases 9, 23, 31) to handle crash, data failure, provider
failure, backup restore, degraded-mode honesty, and repair workflows. It does
**not** widen the authority boundaries established by Guard, Governor, STOP
ALL, approvals and budgets. It does **not** perform any real-money action. It
does **not** add spending authority. It does **not** self-modify trusted
runtime code.

---

## 3. Scope

Phase 36 delivers:

1. **Crash recovery** — bounded, deterministic recovery from process crashes
2. **Data failure recovery** — bounded recovery from data corruption/loss
3. **Provider failure recovery** — bounded recovery from model provider failures
4. **Backup restore** — bounded, auditable backup and restore
5. **Degraded-mode honesty** — truthful degraded-mode operation
6. **Repair workflows** — bounded, authorized repair workflows
7. **No hidden self-modification** — no silent self-modification of trusted code
8. **No authority widening** — every action flows through Guard, Governor,
   STOP ALL, approvals and budgets
9. **Explainable resilience state** — what is being recovered, why, what is
   blocked, what is uncertain, next bounded action

---

## 4. What Phase 36 explicitly does NOT do

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
- Does NOT add real-money/economic actions
- Does NOT add autonomous real-money spending
- Does NOT self-modify trusted runtime code
- Does NOT widen its own authority
- Does NOT perform hidden self-repair

---

## 5. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                 RESILIENCE & SELF-RECOVERY                          │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐     │
│  │    CRASH     │  │    DATA      │  │    PROVIDER          │     │
│  │   RECOVERY   │  │   FAILURE    │  │    FAILURE           │     │
│  │              │  │   RECOVERY   │  │    RECOVERY          │     │
│  │ process crash│  │ corruption   │  │ provider outage      │     │
│  │ state rebuild│  │ data loss    │  │ fallback             │     │
│  │ reconciliation│ │ quarantine   │  │ retry                │     │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘     │
│         │                 │                      │                  │
│         └────────┬────────┘                      │                  │
│                  │                              │                  │
│         ┌────────┴──────────────────────────────┴────────┐        │
│         │           RESILIENCE STATE                     │        │
│         │  what is recovered / why / blocked / uncertain /│        │
│         │  next bounded action                           │        │
│         └────────────────────┬──────────────────────────┘        │
│                              │                                    │
│  ┌───────────────────────────┴───────────────────────────────┐   │
│  │              EXISTING AUTHORITY BOUNDARIES                │   │
│  │  Guard │ Governor │ STOP ALL │ Approvals │ Budgets       │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                      │
│  NO new authority. NO self-modification. NO hidden inference.       │
│  NO continuous reasoning. NO spending authority.                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Component details

### 6.1 Crash Recovery

- Bounded, deterministic recovery from process crashes
- Event-sourced state rebuild
- Interrupted operation reconciliation
- No model calls

### 6.2 Data Failure Recovery

- Bounded recovery from data corruption/loss
- Quarantine of corrupt data
- Trusted prefix replay
- No model calls

### 6.3 Provider Failure Recovery

- Bounded recovery from model provider failures
- Provider fallback within owner-approved providers
- Retry with backoff
- No model calls for deterministic recovery

### 6.4 Backup Restore

- Bounded, auditable backup and restore
- Encrypted backup verification
- Restore validation
- No model calls

### 6.5 Degraded-Mode Honesty

- Truthful degraded-mode operation
- Explicit degraded-mode state
- No fabricated capability
- No model calls

### 6.6 Repair Workflows

- Bounded, authorized repair workflows
- Owner approval for consequential repairs
- Repair verification
- No model calls

### 6.7 Resilience State (explainable)

- What is being recovered now
- Why it matters
- What is blocked
- What is uncertain
- Next bounded action

---

## 7. Authority preservation

Every resilience decision flows through:
1. Guard capability check
2. Governor cognition authorization
3. STOP ALL latch check
4. Budget remaining check
5. Approval requirement check

No component can bypass any of these. No component can perform a real-money
action. No component can self-modify trusted runtime code.

---

## 8. Test plan summary

See `docs/phase36/test-plan.md` for the full test plan.

Key test categories:
1. Unit tests — crash/data/provider recovery, backup restore, degraded mode
2. Integration tests — full resilience flow
3. Red-team tests — authority escalation attempts
4. Zero-idle-inference tests — no model call without wake
5. Restart recovery tests — event-driven resumption
6. Self-modification tests — no hidden self-modification

---

## 9. Acceptance criteria summary

See `docs/phase36/acceptance-criteria.md` for full acceptance criteria.

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
10. All recovery is bounded and auditable
11. All backup/restore is encrypted and verified
12. Degraded mode is truthful
13. No hidden self-modification
14. All repair workflows are authorized

---

## 10. Document index

| Document | Purpose |
|---|---|
| `docs/phase36/architecture.md` | Architecture specification |
| `docs/phase36/interfaces.md` | Compile-time types/interfaces |
| `docs/phase36/crash-recovery.md` | Crash recovery specification |
| `docs/phase36/data-failure-recovery.md` | Data failure recovery specification |
| `docs/phase36/provider-failure-recovery.md` | Provider failure recovery specification |
| `docs/phase36/backup-restore.md` | Backup restore specification |
| `docs/phase36/degraded-mode-honesty.md` | Degraded-mode honesty specification |
| `docs/phase36/repair-workflows.md` | Repair workflows specification |
| `docs/phase36/acceptance-criteria.md` | Acceptance criteria |
| `docs/phase36/test-plan.md` | Test plan |
| `docs/phase36/red-team-cases.md` | Red-team cases |
| `docs/phase36/dependency-map.md` | Dependency map |

---

## 11. NOT PRODUCTION — blocked on integration gate

This entire branch is **preparation only**. No production runtime behavior is
implemented. No code in this branch activates runtime behavior. The branch
contains only documentation, specifications, interfaces and test plans.

**Phase 36 implementation begins only when:**
1. Phase 33 and earlier integrations are green
2. The owner explicitly approves the integration
3. PLAN.md is updated to reflect Phase 36 readiness

Until then, this branch is **blocked** and must not be merged to main.
