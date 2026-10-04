# Phase 33 — Autonomous Enterprise / Webzone

**Status:** PREPARATION ONLY — NOT PRODUCTION  
**Branch:** `prep/phase33-enterprise`  
**Blocked on:** Phase 32 and earlier integrations green  
**Required outcome:** owner-controlled business environment with explicit enterprise boundaries, task/mission orchestration, web presence interfaces, auditability, approvals, spending gates, external-action verification, and rollback/recovery — no hidden spending, no autonomous real-money actions, no authority widening

---

## 1. What this document is

This is a **preparation specification** for Phase 33. It defines the architecture,
interfaces, business environment, enterprise boundaries, task/mission orchestration,
web presence/workzone interfaces, auditability, approvals, spending gates,
external-action verification, rollback/recovery, test plans, red-team cases and
acceptance criteria for Autonomous Enterprise / Webzone. It does **not** implement
production runtime behavior.

**Phase 33 cannot start until Phase 32 and earlier integrations are green.**
This branch exists so that when the gate passes, implementation can begin
immediately without re-deriving the design.

---

## 2. The core invariant

> **Autonomous Enterprise is owner-controlled business operation within explicit
> boundaries. Every action is authorized, auditable, and reversible. No hidden
> spending, no autonomous real-money actions, no authority widening.**

Autonomous Enterprise / Webzone extends Long-Horizon Autonomy (Phase 31) and
Economic Intelligence (Phase 32) to operate a owner-controlled business
environment with explicit enterprise boundaries. It does **not** widen the
authority boundaries established by Guard, Governor, STOP ALL, approvals and
budgets. It does **not** perform any real-money action. It does **not** add
spending authority.

---

## 3. Scope

Phase 33 delivers:

1. **Owner-controlled business environment** — a bounded, explicit business
   environment owned and controlled by the owner
2. **Enterprise boundaries** — explicit, code-owned boundaries that the
   enterprise subsystem cannot cross
3. **Task and mission orchestration** — bounded orchestration of tasks and
   missions within enterprise boundaries
4. **Web presence / workzone interfaces** — bounded, auditable interfaces for
   web presence and workzone operations
5. **Auditability** — every decision, action, and refusal is journaled and
   auditable
6. **Approvals** — owner approval gates for consequential actions
7. **Spending gates** — explicit spending limits with hard ceilings
8. **External-action verification** — verification of external actions before
   they are considered complete
9. **Rollback / recovery** — bounded, explicit rollback and recovery for
   reversible actions
10. **No hidden spending** — zero idle inference, no background reasoning,
    no continuous polling
11. **No authority widening** — every action flows through Guard, Governor,
    STOP ALL, approvals and budgets
12. **Explainable enterprise state** — what is being operated, why, what is
    blocked, what is uncertain, next bounded action

---

## 4. What Phase 33 explicitly does NOT do

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

---

## 5. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                 AUTONOMOUS ENTERPRISE / WEBZONE                     │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐     │
│  │   BUSINESS   │  │   TASK &     │  │   WEB PRESENCE /     │     │
│  │ ENVIRONMENT  │  │   MISSION    │  │   WORKZONE           │     │
│  │              │  │ ORCHESTRATION│  │   INTERFACES         │     │
│  │ owner ctrl   │  │              │  │                      │     │
│  │ boundaries   │  │ task spans   │  │ web interfaces       │     │
│  │ enterprise   │  │ mission spans│  │ workzone ops         │     │
│  │ state        │  │ delegation   │  │ presence             │     │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘     │
│         │                 │                      │                  │
│         └────────┬────────┘                      │                  │
│                  │                              │                  │
│         ┌────────┴──────────────────────────────┴────────┐        │
│         │           ENTERPRISE STATE                     │        │
│         │  what is operated / why / blocked / uncertain /│        │
│         │  next bounded action                           │        │
│         └────────────────────┬──────────────────────────┘        │
│                              │                                    │
│  ┌───────────────────────────┴───────────────────────────────┐   │
│  │              EXISTING AUTHORITY BOUNDARIES                │   │
│  │  Guard │ Governor │ STOP ALL │ Approvals │ Budgets       │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                      │
│  NO new authority. NO real money. NO hidden inference.              │
│  NO continuous reasoning. NO spending authority.                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Component details

### 6.1 Business Environment

- Owner-controlled business environment in Vault
- Explicit enterprise boundaries
- Business state machine: `draft → active → paused → completed/failed/cancelled`
- No model calls

### 6.2 Task & Mission Orchestration

- Bounded orchestration of tasks and missions
- Task spans with explicit checkpoints
- Mission spans with explicit verification
- No model calls

### 6.3 Web Presence / Workzone Interfaces

- Bounded, auditable web presence interfaces
- Workzone operations within enterprise boundaries
- No model calls

### 6.4 Enterprise State (explainable)

- What is being operated now
- Why it matters
- What is blocked
- What is uncertain
- Next bounded action

---

## 7. Authority preservation

Every enterprise decision flows through:
1. Guard capability check
2. Governor cognition authorization
3. STOP ALL latch check
4. Budget remaining check
5. Approval requirement check

No component can bypass any of these. No component can perform a real-money
action.

---

## 8. Test plan summary

See `docs/phase33/test-plan.md` for the full test plan.

Key test categories:
1. Unit tests — business environment, orchestration, webzone interfaces
2. Integration tests — full enterprise flow
3. Red-team tests — authority escalation attempts
4. Zero-idle-inference tests — no model call without wake
5. Restart recovery tests — event-driven resumption
6. Rollback/recovery tests — reversible action rollback

---

## 9. Acceptance criteria summary

See `docs/phase33/acceptance-criteria.md` for full acceptance criteria.

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
10. All enterprise boundaries are enforced
11. All spending gates are enforced
12. All external actions are verified
13. All reversible actions can be rolled back

---

## 10. Document index

| Document | Purpose |
|---|---|
| `docs/phase33/architecture.md` | Architecture specification |
| `docs/phase33/interfaces.md` | Compile-time types/interfaces |
| `docs/phase33/business-environment.md` | Owner-controlled business environment |
| `docs/phase33/enterprise-boundaries.md` | Enterprise boundaries |
| `docs/phase33/task-mission-orchestration.md` | Task and mission orchestration |
| `docs/phase33/webzone-interfaces.md` | Web presence/workzone interfaces |
| `docs/phase33/auditability.md` | Auditability |
| `docs/phase33/approvals.md` | Approvals |
| `docs/phase33/spending-gates.md` | Spending gates |
| `docs/phase33/external-action-verification.md` | External-action verification |
| `docs/phase33/rollback-recovery.md` | Rollback/recovery |
| `docs/phase33/acceptance-criteria.md` | Acceptance criteria |
| `docs/phase33/test-plan.md` | Test plan |
| `docs/phase33/red-team-cases.md` | Red-team cases |
| `docs/phase33/dependency-map.md` | Dependency map |

---

## 11. NOT PRODUCTION — blocked on integration gate

This entire branch is **preparation only**. No production runtime behavior is
implemented. No code in this branch activates runtime behavior. The branch
contains only documentation, specifications, interfaces and test plans.

**Phase 33 implementation begins only when:**
1. Phase 32 and earlier integrations are green
2. The owner explicitly approves the integration
3. PLAN.md is updated to reflect Phase 33 readiness

Until then, this branch is **blocked** and must not be merged to main.
