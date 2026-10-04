# Phase 37 — Architecture Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Sovereign Intelligence is the subsystem that enables Freya to reason
independently of any single provider, optionally offline/local, with portable
encrypted identity and data. It extends the existing Model Gateway
architecture to provide these capabilities.

The core invariant:

> **Sovereign intelligence is provider-independent, optionally offline, and
> portable — without authority widening, without hidden inference, without
> autonomous real-money actions.**

Every decision flows through existing authority paths (Guard, Governor,
STOP ALL, approvals, budgets). No new authority is created. No real-money
action is performed. No trusted runtime code is self-modified.

---

## 2. Design principles

### 2.1 Provider-independent

Reasoning is independent of any single provider. Provider routing is explicit,
deterministic, and within owner-approved providers.

### 2.2 Optionally offline

An optional local/offline reasoning path operates within the same authority
boundaries as online reasoning. It does not widen authority.

### 2.3 Portable

Identity and data are encrypted and portable. They can be exported and
imported across environments without losing integrity or confidentiality.

### 2.4 Deterministic before cognitive

Every decision before a model call is deterministic: same state + same clock
= same result. This is testable, auditable, and safe.

### 2.5 Authority-preserving

The sovereignty subsystem cannot:
- Create grants
- Widen budgets
- Bypass Guard
- Override Governor
- Clear STOP ALL
- Approve its own requests
- Perform real-money actions
- Self-modify trusted runtime code

### 2.6 Explainable

Every sovereignty decision carries:
- What was decided
- Why it was decided
- What alternatives were considered
- What is uncertain
- What is blocked

### 2.7 Zero hidden spend

No model call without a wake. No continuous polling. No hidden reasoning.
No background processing. No self-scheduling timers.

---

## 3. Components

### 3.1 ProviderIndependence (new, Phase 37)

Provider-independent reasoning with explicit routing.

**Responsibilities:**
- Route reasoning requests to owner-approved providers
- Fall back to alternative providers on failure
- Track provider status and health

**Does NOT:**
- Call a model for deterministic routing
- Create authority
- Bypass Guard
- Add new providers

### 3.2 OfflineLocalReasoning (new, Phase 37)

Optional local/offline reasoning path.

**Responsibilities:**
- Provide optional local/offline reasoning
- Operate within the same authority boundaries as online reasoning
- Track offline reasoning state

**Does NOT:**
- Call a model for deterministic decisions
- Create authority
- Bypass Guard
- Widen authority

### 3.3 PortableEncryptedData (new, Phase 37)

Encrypted, portable identity and data.

**Responsibilities:**
- Export encrypted identity and data
- Import encrypted identity and data
- Verify data integrity and confidentiality

**Does NOT:**
- Call a model for deterministic export/import
- Create authority
- Bypass Guard
- Store plaintext data

### 3.4 SovereigntyStateMachine (new, Phase 37)

Manages the sovereignty state transitions.

**States:**
- `ONLINE` — Normal online operation
- `OFFLINE` — Offline/local operation
- `PORTING` — Data export/import in progress
- `DEGRADED` — Operating with reduced capability
- `FAILED` — Unrecoverable failure (terminal)

### 3.5 SovereigntyState (new, Phase 37)

The explainable sovereignty state. Answers:
- What is being reasoned now
- Why it matters
- What is blocked
- What is uncertain
- Next bounded action

---

## 4. Data flow

```
Wake event
    │
    ▼
WakeSourceRegistry.validate(wake)
    │
    ├─ invalid → DENY (journaled)
    │
    ▼ valid
SovereigntyStateMachine.evaluate(state)
    │
    ├─ online → ONLINE
    ├─ offline → OFFLINE
    ├─ porting → PORTING
    ├─ degraded → DEGRADED
    ├─ failed → FAILED (terminal)
    │
    ▼
ProviderIndependence.route(request)
    │
    ├─ primary provider → route
    ├─ fallback provider → route
    ├─ offline → OfflineLocalReasoning
    │
    ▼
Governor.evaluate(request)
    │
    ├─ deny → DENY (journaled)
    │
    ▼ allow
CognitionService.request(intent)
    │
    ├─ denied → DENY (journaled)
    ├─ failed → DEGRADED (retry or fail)
    │
    ▼ allowed
Reasoning result
    │
    ▼
Verification
    │
    ├─ passed → continue or complete
    ├─ failed → FAILED (or retry)
    │
    ▼
Continuation decision
    │
    ├─ continue → ONLINE/OFFLINE (next step)
    ├─ degrade → DEGRADED
    ├─ port → PORTING
    ├─ fail → FAILED (terminal)
```

---

## 5. Integration with existing subsystems

### 5.1 Model Gateway

The sovereignty subsystem uses the Model Gateway for provider-independent
reasoning. It extends it with explicit routing and fallback.

### 5.2 Phase 36 — Resilience & Self-Recovery

The sovereignty subsystem uses Phase 36's resilience for provider failure
recovery and degraded-mode honesty.

### 5.3 Guard

The sovereignty subsystem checks capabilities through `Guard.evaluate()`. It
does not bypass Guard.

### 5.4 Governor

The sovereignty subsystem requests cognition through `Governor.evaluate()`.
It does not bypass Governor.

### 5.5 EventStore

The sovereignty subsystem appends events through `EventFabric.append()`. It
does not create a parallel store.

### 5.6 Vault

The sovereignty subsystem stores sovereignty state in Vault. It does not create
new durable stores.

---

## 6. Boundaries

### 6.1 What the sovereignty subsystem owns

- Provider independence
- Offline/local reasoning
- Portable encrypted data
- Sovereignty state machine
- Sovereignty state projection

### 6.2 What the sovereignty subsystem does NOT own

- Model calls (owned by CognitionService)
- Capability enforcement (owned by Guard)
- Cognition authorization (owned by Governor)
- Work execution (owned by WorkEngine)
- Mission lifecycle (owned by MissionEngine)
- Durable state (owned by EventStore/Vault)
- Real-money actions (not owned by anyone — forbidden)
- Trusted runtime code (not self-modifiable)

---

## 7. Failure modes

| Failure | Handling |
|---|---|
| Provider failure | Fallback to approved provider |
| Offline transition | Switch to offline reasoning |
| Data corruption | Quarantine, replay trusted prefix |
| Import failure | Refuse import, report degraded |
| STOP ALL activated | Immediate halt |
| Journal corrupt | Deny everything |
| Self-modification attempt | Refused, journaled |

---

## 8. Sovereignty invariants

These invariants must hold at all times:

1. **No continuous reasoning** — Reasoning is pursued through discrete wakes.
2. **No hidden spend** — No model call without a wake.
3. **No authority widening** — Every action flows through existing authority.
4. **No real-money actions** — No economic actions are performed.
5. **Deterministic** — Same state + same clock = same result.
6. **Event-sourced** — All state is derived from the journal.
7. **Explainable** — Every decision carries reasoning.
8. **Bounded** — Every operation has a deadline and completion criteria.
9. **Provider-independent** — Reasoning is independent of any single provider.
10. **Optionally offline** — Offline reasoning respects authority.
11. **Portable** — Identity and data are encrypted and portable.
12. **No self-modification** — Trusted runtime code is never self-modified.
