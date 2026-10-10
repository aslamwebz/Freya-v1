# FREYA MIND — Phase 6 Architecture
## Proactive Intelligence, Event Awareness and Intelligent Initiative

**Date**: 2026-10-10  
**Branch**: `feat/mind-phase6-proactive-intelligence`  
**Status**: Implemented & Verified  

---

## 1. Executive Summary

Phase 6 elevates Freya from a system that solely reacts to incoming user prompts into an **attentive, governed, proactive intelligence system**. Freya understands the owner's enduring goals, recognizes meaningful changes in her environment, reasons about their significance, and initiates bounded, authorized continuation without unbudgeted background activity.

Autonomy without governance is dangerous; proactivity without boundaries quickly degenerates into hallucinated background work and uncontrolled API token expenditure. Phase 6 balances alertness and restraint through code-owned architectural invariants:
1. **The Fundamental Architectural Invariant**: *An event can justify reconsidering work. It cannot grant permission to perform it.* Neither an external webhook, RSS article, git commit, nor model suggestion can ever mint execution authority.
2. **Tripartite Epistemology**: Freya structurally separates **Observed** (the raw signal envelope received), **Claimed** (what an external source asserts occurred), and **Verified** (what trusted verification has established). External claims never become verified truth simply because they arrived through an authorized connector.
3. **Deterministic Relevance Prefilter (Strictly 0 Model Tokens)**: Background noise, uncorrelated events, and updates referencing cancelled, completed, or failed goals are rejected deterministically before touching an LLM.
4. **Closed Decision & Opportunity Vocabularies**: Cognition and initiative operate within closed sets. Hallucinated actions outside this vocabulary are clamped by a code-owned Deterministic Safety Governor.
5. **Action Boundaries (Levels 1, 2, 3)**:
   - **Level 1 (Direct / Pre-authorized)**: Cheap, non-destructive actions (`ignore`, `record`, `defer`, `notify`, and `continue_existing_mission` only when all preconditions were pre-authorized).
   - **Level 2 (Bounded Diagnostic Investigation)**: Read-only investigative probes restricted by hard code-owned ceilings (maximum 3 probes, maximum 1,000 tokens). Budget exhaustion automatically escalates to Level 3.
   - **Level 3 (Governed / Owner Approval Required)**: High-impact actions, scope additions, and continuation without satisfied prerequisites require explicit owner authorization.
6. **Encrypted Evidence Vault & Multi-Session Durability**: Raw sensitive payloads reside exclusively in SQLCipher encrypted storage (`vault_kv`), while deduplication indices, source subscriptions, and audit metadata survive application restarts.

---

## 2. Subsystem Ownership & Architectural Topology

No duplicate intelligence engine or independent polling scheduler was created. Phase 6 extends and unifies the existing Core architecture:

```
+---------------------------------------------------------------------------------------------------------+
|                                               FREYA CORE                                                |
|                                                                                                         |
|   +-----------------------+                         +-----------------------------------------------+   |
|   |  External Connectors  | -- Authorized Signals -> |               ProactiveEngine                 |   |
|   |   & Monitored Sources |                         | (Subscriptions, Dedup, Prefilter, Governed Act) |   |
|   +-----------------------+                         +-----------------------------------------------+   |
|                                                                     |                                   |
|                                                       1. Deterministic Prefilter                        |
|                                                          (0 tokens for noise)                           |
|                                                                     v                                   |
|   +-----------------------+                         +-----------------------------------------------+   |
|   |  LongHorizon Domain   | <--- Goal Association - |               ProactiveReasoner               |   |
|   |   (Goals & Budgets)   |                         |  (Bounded LLM Reasoning + Safety Governor)     |   |
|   +-----------------------+                         +-----------------------------------------------+   |
|                                                                     |                                   |
|                                                       2. Governed Action Policy                         |
|                                                          (Level 1 / Level 2 / Level 3)                  |
|                                                                     v                                   |
|   +-----------------------+     Level 1 Notification    +-----------------------------------------------+   |
|   |   Attention Domain    | <======================== |             Action Policy Execution           |   |
|   |  (Presence Cue/Inbox) |                         +-----------------------------------------------+   |
|   +-----------------------+                                         |                                   |
|                                                         Level 1 Continuation Wake                       |
|                                                                     v                                   |
|   +-----------------------+    Audit Journal Events +-----------------------------------------------+   |
|   |      EventFabric      | <====================== |               ContinuationEngine              |   |
|   | (Immutable Log/Disk)  |                         |        (Wakes, LifeLoop & Executive)          |   |
|   +-----------------------+                         +-----------------------------------------------+   |
|                                                                     |                                   |
|                                                             Emergency Latches                           |
|                                                                     v                                   |
|   +-----------------------+                         +-----------------------------------------------+   |
|   |   Guard & Governor    | <====== STOP ALL ====== |           Encrypted SQLCipher Vault           |   |
|   | (Authority Checkers)  |                         |   (Subscriptions, Dedup, Private Evidence)   |   |
|   +-----------------------+                         +-----------------------------------------------+   |
+---------------------------------------------------------------------------------------------------------+
```

| Subsystem | Responsibilities in Phase 6 |
|---|---|
| **ProactiveEngine** | Ingestion door, source authorization check, event normalization, deduplication registry, and action orchestration. |
| **DeterministicRelevanceFilter** | Pre-evaluates observations without model calls. Checks validity, freshness, goal state, and correlation. Guarantees 0 tokens spent on noise. |
| **ProactiveMindReasoner** | Evaluates significance of relevant observations. Formulates advisory proposals. Supervised by Deterministic Safety Governor. |
| **GovernedActionPolicy** | Enforces action boundaries (Level 1, Level 2, Level 3), probe budgets, continuation prerequisite checks, and STOP ALL suppression. |
| **AttentionDomain** | Receives Level 1 proactive notifications via `ingestInternal('system', { kind: 'context-change', ... })` without bypassing cues or user focus. |
| **ContinuationEngine** | Wakes authorized existing missions via registered continuation wakes (`source: 'proactive', cause: 'external_event'`). |
| **EventFabric** | Appends verifiable, schema-validated journal records (`proactive.observation.received`, `proactive.observation.dropped`, `proactive.subscription.updated`, `proactive.relevance.evaluated`, `proactive.decision.made`). |
| **Vault (SQLCipher)** | Securely persists active observation subscriptions, deduplication history, and private evidence payloads under domain `'proactive'`. |
| **Guard / Governor** | Enforces STOP ALL and ensures external signals cannot expand authorization. |

---

## 3. Phase 6A — Unified Event Awareness & Epistemology

### 3.1 Tripartite Epistemological Model

External events cannot be accepted blindly as truth. Every normalized observation separates:

```typescript
export interface NormalizedObservation {
  readonly observationId: string
  readonly correlationId: string
  readonly dedupeKey: string
  readonly sourceType: ObservationSourceType
  readonly sourceId: string
  readonly sourceRef: string
  readonly observedAt: string
  readonly eventTimestamp: string | null
  readonly receivedAt: string
  readonly trust: ObservationTrust
  readonly verificationStatus: ObservationVerificationStatus
  readonly claim: {
    readonly rawSummary: string
    readonly predicate: string
  }
  readonly goalId: string | null
  readonly milestoneId: string | null
  readonly missionId: string | null
  readonly evidenceRef: string | null
  readonly expiresAt: string | null
  readonly sensitivity: ObservationSensitivity
}
```

- **Observed**: Envelope metadata (`sourceType`, `sourceId`, `sourceRef`, `observedAt`, `receivedAt`).
- **Claimed**: What the external source asserts (`predicate`, `rawSummary`). Untrusted by default.
- **Verified**: Verification state (`unverified` initially, promoted only by trusted verification routines).

### 3.2 Subscription Registry & Consent

Freya does not snoop on the owner's system by default. External sources must be explicitly subscribed to with owner consent:

```typescript
export interface ObservationSubscription {
  readonly subscriptionId: string
  readonly sourceId: string
  readonly sourceType: string
  readonly scope: string
  readonly allowedTypes: readonly string[]
  readonly active: boolean
  readonly expiresAt: string | null
  readonly maxObservationsPerHour: number
  readonly consentGranted: boolean
  readonly registeredAt: string
}
```

Observations arriving without an active, matching subscription or with `consentGranted === false` are immediately dropped with reason `'unauthorized-source'`.

### 3.3 Deduplication & Replay Protection

Deduplication keys are deterministically derived via SHA-256 over `(sourceType, sourceId, sourceRef, rawSummary)`.
- Replayed deliveries within their expiration window are dropped with `dropCode: 'duplicate'`.
- Deduplication records persist in the encrypted SQLCipher store across Core restarts.

### 3.4 Confidential Evidence Storage

Private payloads (such as API keys, vulnerability codes, personal emails, or raw text) must never leak into append-only event journals or public transcripts.
- Raw observation details are stored encrypted in the SQLCipher Vault (`domain = 'proactive'`).
- The journal logs only the reference ID (`evidenceRef`). Plaintext journals (`events.jsonl`) remain strictly clean of sensitive payloads.

---

## 4. Phase 6B — Relevance, Opportunity & Threat Reasoning

### 4.1 Deterministic Relevance Prefilter (Strictly Zero Token Cost)

Before any LLM is contacted, `DeterministicRelevanceFilter` evaluates the event:
1. **Freshness**: Expired events are dropped (`tokensCost: 0`).
2. **Unauthorized Initiatives**: External payloads attempting to run commands, invoke tools, or supply system instructions are trapped deterministically (`unauthorized_initiative_request`, `tokensCost: 0`).
3. **Goal-Aware Status**:
   - Non-existent goal -> Irrelevant (`tokensCost: 0`).
   - Terminal goal (`cancelled`, `completed`, `failed`) -> Irrelevant (`tokensCost: 0`).
   - Paused goal -> Irrelevant unless specifically matching unblocking keywords.
   - Active goal -> Evaluated for progress, threats, or information updates.
4. **Workforce & Scheduled Reviews**: Structural platform events (workforce availability changes, scheduled review deadlines) are matched via closed rules.

### 4.2 Closed Opportunity Vocabulary

Relevance is classified into a bounded 8-element vocabulary:
```typescript
export const OPPORTUNITY_TYPES = [
  'goal_progress_opportunity',
  'threat_to_goal',
  'resource_unblocked',
  'stalled_work',
  'information_update',
  'scheduled_obligation',
  'unauthorized_initiative_request',
  'unclassified_noise',
] as const
```

### 4.3 Bounded Mind Reasoning & Closed Candidate Actions

If and only if an event is relevant and warrants cognitive evaluation, `ProactiveMindReasoner` invokes the model. The model is asked to evaluate significance, propose candidate actions, and specify verification criteria:

```typescript
export const PROACTIVE_CANDIDATE_ACTIONS = [
  'ignore',
  'record',
  'defer',
  'notify',
  'request_approval',
  'investigate',
  'continue_existing_mission',
] as const
```

### 4.4 Deterministic Safety Governor

Model responses are strictly advisory. `applyDeterministicSafetyGovernor` enforces:
1. **Anti-Hallucination**: If the model proposes an action outside the 7 closed candidate actions, the governor overrides it to `'notify'` (`wasOverridden: true`).
2. **Untrusted Continuation Prevention**: An external or untrusted event recommending `'continue_existing_mission'` is clamped to `'request_approval'` (`wasOverridden: true`).
3. **Initiative Containment**: Any external unauthorized initiative attempt is clamped to `'request_approval'`.

---

## 5. Phase 6C — Governed Action Policy & Boundaries

`GovernedActionPolicy` transforms advisory proposals into authoritative governed decisions:

```typescript
export type ActionLevel = 1 | 2 | 3

export interface ProactiveGovernedDecision {
  readonly decisionId: string
  readonly observationId: string
  readonly decision: ProactiveCandidateAction
  readonly level: ActionLevel
  readonly actionRef: string | null
  readonly reason: string
  readonly requiresApproval: boolean
  readonly executed: boolean
  readonly outcome: string
}
```

### 5.1 Action Level Hierarchy

| Level | Classification | Eligible Actions | Invariants & Ceilings |
|---|---|---|---|
| **Level 1** | **Direct / Pre-authorized** | `ignore`, `record`, `defer`, `notify`, `continue_existing_mission` | Non-destructive. Notification routes through Attention engine. Continuation allowed only when all 6 prerequisites are verified. |
| **Level 2** | **Bounded Diagnostic Investigation** | `investigate` | Diagnostic read-only probing. **Strict ceiling**: Max 3 probes, max 1,000 tokens. Reaching limit escalates to Level 3. |
| **Level 3** | **Governed / Approval Required** | `request_approval` | Requires explicit owner confirmation. Execution halted until owner decides. |

### 5.2 Continuation Verification Invariants

Continuation of an existing mission (`continue_existing_mission`) is permitted at Level 1 if and only if **all six prerequisites** are satisfied:
1. `goalIsActive === true`: The parent goal is in state `active`.
2. `missionIsWaiting === true`: The target mission is parked in `waiting`, `stopped`, or `ready`.
3. `milestonePreconditionsMet === true`: Milestone dependencies are fulfilled.
4. `budgetRemaining > 0`: Goal and mission budgets have remaining capacity.
5. `principalAuthorized === true`: The owner previously authorized this milestone/mission.
6. `stopAllActive === false`: Emergency STOP ALL is not engaged.

If any prerequisite fails, the decision is escalated to Level 3 `request_approval` (`requiresApproval: true, executed: false`).

### 5.3 Attention Engine & Continuation Integration

- **Notification Dispatch**: Level 1 `notify` executes via `attentionEngine.ingestInternal('system', { kind: 'context-change', text: decision.reason, goalRef, sourceRef, severityHint })`. Attention engine policies (cooldowns, focus suppression, cue rendering) remain fully authoritative.
- **Continuation Wake**: Level 1 continuation signals `continuationEngine.handleContinuationWake({ goalId, source: 'proactive', cause: 'external_event', authorized: true })`.

### 5.4 Journal Audit Trail (`proactive.decision.made`)

Every proactive decision is journaled to EventFabric with exact schema validation:
```typescript
{
  decisionId: string,
  observationId: string,
  decision: string,
  level: number,
  actionRef: string | null,
  reason: string
}
```

---

## 6. Phase 6D — Multi-Session Durability & Emergency Stop

### 6.1 Multi-Session Durability

Across Core shutdowns and restarts:
1. **Goals Reconcile Safely**: In accordance with LongHorizon invariants, active goals reconcile to `paused` upon restart and require resume.
2. **Subscriptions Survive Truthfully**: Active subscriptions load from the encrypted Vault upon Core initialization.
3. **Deduplication Persists**: Events previously seen in earlier sessions cannot be replayed to trigger duplicate decisions or notifications.
4. **Confidential Evidence Survives**: Encrypted raw details remain decryptable with valid key credentials across sessions.

### 6.2 Emergency STOP ALL Authority

The panic button remains absolute:
- When STOP ALL is latched, incoming observations are immediately dropped with reason `'stop-all-active'`.
- All proactive actions are suppressed (`decision: 'defer'`, `executed: false`).
- No Attention notifications, diagnostic probes, or continuation wakes can occur while STOP ALL is active.

---

## 7. Architectural Guarantees & Verification Summary

| Invariant | Implementation Mechanism | Verification Test |
|---|---|---|
| **Zero Model Tokens for Noise** | `DeterministicRelevanceFilter.evaluate()` | `tests/core/proactive-relevance.test.ts` |
| **No Autonomous Initiative from External Claims** | Epistemological separation + Safety Governor | `tests/core/proactive-relevance.test.ts` |
| **Probe Budget Ceilings** | `PROBE_BUDGET_LIMITS` (3 probes, 1,000 tokens) | `tests/core/proactive-governance.test.ts` |
| **Continuation Boundary Protection** | `checkContinuationPrerequisites` evaluation | `tests/core/proactive-governance.test.ts` |
| **Encrypted Evidence Confidentiality** | `ProactiveStore.writeEvidence` in SQLCipher Vault | `tests/core/proactive-awareness.test.ts` |
| **Multi-Session Restart Survival** | SQLCipher Vault durability across 3 Core restarts | `tests/core/proactive-multisession.test.ts` |
| **Authoritative STOP ALL Halting** | Latched state drops observations and defers actions | `tests/core/proactive-governance.test.ts` |
