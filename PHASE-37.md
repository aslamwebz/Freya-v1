# Phase 37 — Sovereign Intelligence

**Status:** PREPARATION ONLY — NOT PRODUCTION  
**Branch:** `prep/phase37-sovereign`  
**Blocked on:** Phase 36 and earlier integrations green  
**Required outcome:** provider-independent, optionally offline/local reasoning with portable encrypted identity/data — no authority widening, no hidden inference

---

## 1. What this document is

This is a **preparation specification** for Phase 37. It defines the architecture,
interfaces, provider independence, optional offline/local reasoning, portable
encrypted identity/data, test plans, red-team cases and acceptance criteria
for Sovereign Intelligence. It does **not** implement production runtime
behavior.

**Phase 37 cannot start until Phase 36 and earlier integrations are green.**
This branch exists so that when the gate passes, implementation can begin
immediately without re-deriving the design.

---

## 2. The core invariant

> **Sovereign intelligence is provider-independent, optionally offline, and
> portable — without authority widening, without hidden inference, without
> autonomous real-money actions.**

Sovereign Intelligence extends the existing Model Gateway architecture to
provide provider independence, an optional offline/local reasoning path, and
portable encrypted identity/data. It does **not** widen the authority
boundaries established by Guard, Governor, STOP ALL, approvals and budgets.
It does **not** perform any real-money action. It does **not** add spending
authority.

---

## 3. Scope

Phase 37 delivers:

1. **Provider independence** — reasoning that is independent of any single
   provider, with explicit provider routing
2. **Optional offline/local reasoning** — an optional local/offline reasoning
   path that operates within the same authority boundaries
3. **Portable encrypted identity/data** — encrypted, portable identity and
   data that can be exported and imported across environments
4. **No authority widening** — every action flows through Guard, Governor,
   STOP ALL, approvals and budgets
5. **No hidden inference** — zero idle inference, no background reasoning,
   no continuous polling
6. **Explainable sovereignty state** — what is being reasoned, why, what is
   blocked, what is uncertain, next bounded action

---

## 4. What Phase 37 explicitly does NOT do

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

---

## 5. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                   SOVEREIGN INTELLIGENCE                            │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐     │
│  │   PROVIDER   │  │   OFFLINE /  │  │   PORTABLE           │     │
│  │ INDEPENDENCE │  │   LOCAL      │  │   ENCRYPTED          │     │
│  │              │  │   REASONING  │  │   IDENTITY/DATA      │     │
│  │ routing      │  │              │  │                      │     │
│  │ fallback     │  │ local model  │  │ export/import        │     │
│  │ multi-provider│ │ offline path │  │ encrypted transfer   │     │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘     │
│         │                 │                      │                  │
│         └────────┬────────┘                      │                  │
│                  │                              │                  │
│         ┌────────┴──────────────────────────────┴────────┐        │
│         │           SOVEREIGNTY STATE                    │        │
│         │  what is reasoned / why / blocked / uncertain / │        │
│         │  next bounded action                           │        │
│         └────────────────────┬──────────────────────────┘        │
│                              │                                    │
│  ┌───────────────────────────┴───────────────────────────────┐   │
│  │              EXISTING AUTHORITY BOUNDARIES                │   │
│  │  Guard │ Governor │ STOP ALL │ Approvals │ Budgets       │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                      │
│  NO new authority. NO hidden inference. NO autonomous spend.        │
│  NO continuous reasoning. NO spending authority.                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Component details

### 6.1 Provider Independence

- Provider-independent reasoning with explicit routing
- Multi-provider fallback within owner-approved providers
- No model calls for deterministic routing

### 6.2 Offline / Local Reasoning

- Optional local/offline reasoning path
- Same authority boundaries as online reasoning
- No model calls for deterministic decisions

### 6.3 Portable Encrypted Identity/Data

- Encrypted, portable identity and data
- Export/import across environments
- No model calls for deterministic export/import

### 6.4 Sovereignty State (explainable)

- What is being reasoned now
- Why it matters
- What is blocked
- What is uncertain
- Next bounded action

---

## 7. Authority preservation

Every sovereignty decision flows through:
1. Guard capability check
2. Governor cognition authorization
3. STOP ALL latch check
4. Budget remaining check
5. Approval requirement check

No component can bypass any of these. No component can perform a real-money
action. No component can self-modify trusted runtime code.

---

## 8. Test plan summary

See `docs/phase37/test-plan.md` for the full test plan.

Key test categories:
1. Unit tests — provider independence, offline reasoning, portable data
2. Integration tests — full sovereignty flow
3. Red-team tests — authority escalation attempts
4. Zero-idle-inference tests — no model call without wake
5. Restart recovery tests — event-driven resumption

---

## 9. Acceptance criteria summary

See `docs/phase37/acceptance-criteria.md` for full acceptance criteria.

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
10. Provider independence is enforced
11. Offline reasoning respects authority
12. Portable data is encrypted
13. No hidden self-modification

---

## 10. Document index

| Document | Purpose |
|---|---|
| `docs/phase37/architecture.md` | Architecture specification |
| `docs/phase37/interfaces.md` | Compile-time types/interfaces |
| `docs/phase37/provider-independence.md` | Provider independence specification |
| `docs/phase37/offline-local-reasoning.md` | Offline/local reasoning specification |
| `docs/phase37/portable-encrypted-data.md` | Portable encrypted identity/data specification |
| `docs/phase37/acceptance-criteria.md` | Acceptance criteria |
| `docs/phase37/test-plan.md` | Test plan |
| `docs/phase37/red-team-cases.md` | Red-team cases |
| `docs/phase37/dependency-map.md` | Dependency map |

---

## 11. NOT PRODUCTION — blocked on integration gate

This entire branch is **preparation only**. No production runtime behavior is
implemented. No code in this branch activates runtime behavior. The branch
contains only documentation, specifications, interfaces and test plans.

**Phase 37 implementation begins only when:**
1. Phase 36 and earlier integrations are green
2. The owner explicitly approves the integration
3. PLAN.md is updated to reflect Phase 37 readiness

Until then, this branch is **blocked** and must not be merged to main.
