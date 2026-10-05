# Phase 38 — Cognitive Evolution

**Status:** PREPARATION ONLY — NOT PRODUCTION  
**Branch:** `prep/phase38-cognitive-evolution`  
**Blocked on:** Phase 37 and earlier integrations green  
**Required outcome:** evidence-driven improvement of planning/reasoning/learning without authority drift — no hidden self-modification, no authority widening

---

## 1. What this document is

This is a **preparation specification** for Phase 38. It defines the architecture,
interfaces, evidence-driven improvement, planning/reasoning/learning improvement,
authority drift prevention, test plans, red-team cases and acceptance criteria
for Cognitive Evolution. It does **not** implement production runtime behavior.

**Phase 38 cannot start until Phase 37 and earlier integrations are green.**
This branch exists so that when the gate passes, implementation can begin
immediately without re-deriving the design.

---

## 2. The core invariant

> **Cognitive evolution is evidence-driven improvement without authority drift.
> Every improvement is authorized, auditable, and reversible. No hidden
> self-modification, no authority widening, no autonomous real-money actions.**

Cognitive Evolution extends the existing Experience → Knowledge → Skill
architecture (Phase 28) and Self-Improving Architecture (Phase 30) to provide
evidence-driven improvement of planning, reasoning, and learning. It does
**not** widen the authority boundaries established by Guard, Governor, STOP
ALL, approvals and budgets. It does **not** perform any real-money action. It
does **not** add spending authority. It does **not** self-modify trusted
runtime code.

---

## 3. Scope

Phase 38 delivers:

1. **Evidence-driven improvement** — improvement based on verified evidence
2. **Planning improvement** — evidence-driven improvement of planning
3. **Reasoning improvement** — evidence-driven improvement of reasoning
4. **Learning improvement** — evidence-driven improvement of learning
5. **Authority drift prevention** — explicit prevention of authority drift
6. **No hidden self-modification** — no silent self-modification of trusted code
7. **No authority widening** — every action flows through Guard, Governor,
   STOP ALL, approvals and budgets
8. **Explainable evolution state** — what is being improved, why, what is
   blocked, what is uncertain, next bounded action

---

## 4. What Phase 38 explicitly does NOT do

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
- Does NOT perform hidden self-improvement

---

## 5. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    COGNITIVE EVOLUTION                             │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐     │
│  │  EVIDENCE-   │  │  PLANNING /  │  │   AUTHORITY DRIFT    │     │
│  │  DRIVEN      │  │  REASONING / │  │   PREVENTION         │     │
│  │  IMPROVEMENT │  │  LEARNING    │  │                      │     │
│  │              │  │  IMPROVEMENT │  │ drift detection      │     │
│  │ evidence     │  │              │  │ boundary enforcement │     │
│  │ verification │  │ planning     │  │ no self-modification │     │
│  │ metrics      │  │ reasoning    │  │ no authority widening│     │
│  │              │  │ learning     │  │                      │     │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘     │
│         │                 │                      │                  │
│         └────────┬────────┘                      │                  │
│                  │                              │                  │
│         ┌────────┴──────────────────────────────┴────────┐        │
│         │           EVOLUTION STATE                      │        │
│         │  what is improved / why / blocked / uncertain / │        │
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

### 6.1 Evidence-Driven Improvement

- Improvement based on verified evidence
- Explicit evidence requirements
- No model calls for deterministic evidence verification

### 6.2 Planning / Reasoning / Learning Improvement

- Evidence-driven improvement of planning
- Evidence-driven improvement of reasoning
- Evidence-driven improvement of learning
- No model calls for deterministic improvement

### 6.3 Authority Drift Prevention

- Explicit prevention of authority drift
- Boundary enforcement
- No self-modification
- No authority widening

### 6.4 Evolution State (explainable)

- What is being improved now
- Why it matters
- What is blocked
- What is uncertain
- Next bounded action

---

## 7. Authority preservation

Every evolution decision flows through:
1. Guard capability check
2. Governor cognition authorization
3. STOP ALL latch check
4. Budget remaining check
5. Approval requirement check

No component can bypass any of these. No component can perform a real-money
action. No component can self-modify trusted runtime code.

---

## 8. Test plan summary

See `docs/phase38/test-plan.md` for the full test plan.

Key test categories:
1. Unit tests — evidence-driven improvement, planning/reasoning/learning, drift prevention
2. Integration tests — full evolution flow
3. Red-team tests — authority escalation attempts
4. Zero-idle-inference tests — no model call without wake
5. Restart recovery tests — event-driven resumption
6. Self-modification tests — no hidden self-modification

---

## 9. Acceptance criteria summary

See `docs/phase38/acceptance-criteria.md` for full acceptance criteria.

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
10. All improvement is evidence-driven
11. All improvement is authorized
12. No authority drift
13. No hidden self-modification
14. All evolution is auditable

---

## 10. Document index

| Document | Purpose |
|---|---|
| `docs/phase38/architecture.md` | Architecture specification |
| `docs/phase38/interfaces.md` | Compile-time types/interfaces |
| `docs/phase38/evidence-driven-improvement.md` | Evidence-driven improvement specification |
| `docs/phase38/planning-reasoning-learning.md` | Planning/reasoning/learning improvement specification |
| `docs/phase38/authority-drift-prevention.md` | Authority drift prevention specification |
| `docs/phase38/acceptance-criteria.md` | Acceptance criteria |
| `docs/phase38/test-plan.md` | Test plan |
| `docs/phase38/red-team-cases.md` | Red-team cases |
| `docs/phase38/dependency-map.md` | Dependency map |

---

## 11. NOT PRODUCTION — blocked on integration gate

This entire branch is **preparation only**. No production runtime behavior is
implemented. No code in this branch activates runtime behavior. The branch
contains only documentation, specifications, interfaces and test plans.

**Phase 38 implementation begins only when:**
1. Phase 37 and earlier integrations are green
2. The owner explicitly approves the integration
3. PLAN.md is updated to reflect Phase 38 readiness

Until then, this branch is **blocked** and must not be merged to main.
