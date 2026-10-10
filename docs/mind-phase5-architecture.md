# FREYA MIND — Phase 5 Architecture
## Long-Term Autonomous Goals, Persistent Intent, and Goal Continuation

**Date**: 2026-10-10  
**Branch**: `feat/mind-phase5-longhorizon-goals`  
**Status**: Implemented & Verified  

---

## 1. Executive Summary

Phase 5 elevates Freya from executing individual Missions in isolation to maintaining **enduring, persistent long-term goals across days, weeks, and application restarts**.

In previous phases, Freya proved bounded mission execution (Phase 1), verified capabilities (Phase 2), closed-loop learning from experience (Phase 3), and unified executive prioritization across concurrent tasks (Phase 4). However, real-world autonomy requires sustaining commitments over extended horizons: initiatives that cannot finish in a single session, require progressive elaboration through intermediate milestones, depend on external events or prerequisite completion, and strictly respect non-widening financial and computational budgets.

Phase 5 achieves this through a principled architecture:
1. **Enduring Commitments with Honest Boundaries**: Mind formulates intent; LongHorizon remembers commitments; Executive prioritizes; Missions executes bounded scopes; Work performs actions; Verification establishes truth; LifeLoop coordinates continuation; Learning informs decomposition; Guard/Governor enforces boundaries.
2. **Storage Separation & Confidentiality**: Metadata transitions exist in an append-only verifiable event journal (`events.jsonl`), while confidential goal descriptions, acceptance criteria, roadmaps, and spend records reside exclusively in encrypted SQLCipher storage (`vault_kv`).
3. **Progressive Milestone Decomposition**: Long-term initiatives are decomposed into a Directed Acyclic Graph (DAG) of bounded milestones. Milestones are topologically sorted, validated against strict structural invariants, and progressively elaborated into bounded missions.
4. **Strict Budget Hierarchy**: `Owner Budget -> Goal Budget -> Milestone/Mission Budget -> Work Step Limits`. Budgets cannot widen downstream; autonomous execution loops cannot widen their own budgets; budget exhaustion automatically pauses active goals.
5. **Governed Continuation & Anti-Hallucination**: The continuation engine transitions strictly on registered, authorized wakes. Spurious or hallucinated model wakes are rejected.
6. **Honest Restart Recovery**: Freya refuses to fabricate progress or simulate execution during process downtime. Active goals are paused with `recovery`, and interrupted in-flight work is marked `failed` with `restart_interrupted`.

---

## 2. Subsystem Ownership & Architectural Topology

```
+---------------------------------------------------------------------------------------------+
|                                         FREYA CORE                                          |
|                                                                                             |
|   +-----------------------+                         +-----------------------------------+   |
|   |      Mind Domain      | -- Intent & Proposal -> |        LongHorizon Domain         |   |
|   |  (Reasoning & Intent) |                         | (Goals, Roadmaps, Wakes, Budgets) |   |
|   +-----------------------+                         +-----------------------------------+   |
|               |                                                       |                     |
|         Advisory Lessons                                     Elaborated Milestones          |
|               v                                                       v                     |
|   +-----------------------+                         +-----------------------------------+   |
|   |    Learning Domain    |                         |         Executive Domain          |   |
|   | (Prior Verified Exp)  |                         |    (Prioritization & Workers)     |   |
|   +-----------------------+                         +-----------------------------------+   |
|                                                                       |                     |
|                                                              Scheduled Mission Allocation   |
|                                                                       v                     |
|   +-----------------------+    Budget Policies      +-----------------------------------+   |
|   |   Guard & Governor    | <====================== |          Missions Domain          |   |
|   | (Authority & Limits)  |                         |    (Durable Bounded Execution)    |   |
|   +-----------------------+                         +-----------------------------------+   |
|               |                                                       |                     |
|       Hard STOP ALL Latch                                   Capability Invocations          |
|               v                                                       v                     |
|   +-----------------------+                         +-----------------------------------+   |
|   |   Workforce Domain    |                         |            Work Domain            |   |
|   | (Workers & Execution) |                         |      (Actions & Verifiers)        |   |
|   +-----------------------+                         +-----------------------------------+   |
|                                                                       |                     |
|                                                             Independent Verification        |
|                                                                       v                     |
|   +-------------------------------------------------------------------------------------+   |
|   |                                  PERSISTENCE                                        |   |
|   |  Append-Only Event Journal (Metadata)  |  Encrypted SQLCipher Vault (Confidential)  |   |
|   +-------------------------------------------------------------------------------------+   |
+---------------------------------------------------------------------------------------------+
```

### Subsystem Boundaries
- **Mind**: Formulates understanding and articulates proposals. Does not directly mutate durable storage.
- **LongHorizon**: Maintains enduring commitments, milestone roadmaps, continuation state machines, and cumulative goal spend.
- **Executive**: Prioritizes eligible work and allocates resources fairly across concurrent goals. Does not grant execution authority.
- **Missions**: Executes discrete, bounded steps towards a milestone.
- **Work**: Executes registered capabilities and independent verification probes.
- **Verification**: Independently establishes whether checkpoints and milestones actually passed.
- **LifeLoop**: Coordinates review intervals and event-driven wake dispatching.
- **Learning**: Provides verified historical insights as advisory evidence to improve future planning.
- **Guard & Governor**: Enforces authorization boundaries, capability permissions, and cognition spend limits.

---

## 3. Storage Separation & Verifiable Ledger

Freya enforces a strict cryptographic and structural separation between audit metadata and private goal text:

### 3.1 Durable Event Journal (`events.jsonl`)
The event journal records auditable state machine facts. It intentionally contains **zero private user text**:
- `longhorizon.goal.created`: Goal ID, initial state (`draft`), timestamps, dependency IDs, ceiling limits.
- `longhorizon.goal.state-changed`: Goal ID, transition (`from` -> `to`), closed reason code (`owner`, `recovery`, `budget_exhausted`, `verification_passed`, etc.).
- `longhorizon.goal.roadmap-updated`: Goal ID, roadmap revision number, milestone count.
- `longhorizon.goal.milestone-settled`: Goal ID, milestone ID, closed outcome code (`completed`, `failed`, `cancelled`, `deferred`), revision number.
- `longhorizon.checkpoint.started`: Goal ID, checkpoint ID, order index, kind code.
- `longhorizon.checkpoint.verified`: Goal ID, checkpoint ID, outcome (`passed`), closed reason.
- `longhorizon.checkpoint.failed`: Goal ID, checkpoint ID, closed failure reason code, attempt count.
- `longhorizon.continuation.decided`: Goal ID, decision (`continue`, `pause`, `complete`, `fail`, `wait`), audit reason.

### 3.2 Encrypted SQLCipher Vault (`vault_kv`)
Private goal definitions and detailed plan structures are stored exclusively in the AES-256-GCM encrypted database under key prefix `goal:content:<goalId>`:
- **Title and Description**: Natural language problem definition.
- **Completion Criteria**: Array of verifiable human conditions.
- **Roadmap**: Structured DAG of milestones, intents, expected outcomes, acceptance criteria, and dependency IDs.
- **Budget Policy & Cumulative Spend**: Upper bounds and exact counters for `modelCalls`, `actions`, `externalRequests`, and `missions`.

This design guarantees that exported or shared event journals cannot leak proprietary goals or user instructions, while maintaining 100% deterministic replayability of lifecycle state.

---

## 4. Milestone DAG Decomposition & Progressive Elaboration

A multi-month autonomous initiative cannot safely be planned as a flat list of hundreds of microscopic steps. Freya employs **Progressive Elaboration**:

```
[Long-Term Goal]
       |
       +---> [Milestone 1: Market & Architecture Analysis]  (Dependencies: [])
       |            |
       |            +---> Bounded Mission 1.1 -> Checkpoint 1 (Verified)
       |
       +---> [Milestone 2: Core Engine Prototype]           (Dependencies: [Milestone 1])
       |            |
       |            +---> Bounded Mission 2.1 -> Checkpoint 2 (Verified)
       |
       +---> [Milestone 3: Production Verification]         (Dependencies: [Milestone 2])
                    |
                    +---> Bounded Mission 3.1 -> Checkpoint 3 (Verified)
```

### 4.1 DAG Structural Integrity (`core/longhorizon/decomposition/dag.ts`)
1. **Cycle Detection**: Evaluated using 3-color Depth-First Search (`WHITE`, `GRAY`, `BLACK`). Any cyclic loop (`A -> B -> A`) is rejected.
2. **Self-Dependency**: Milestones depending on themselves (`A -> A`) are rejected.
3. **Dangling References**: Dependencies referencing non-existent milestone IDs are rejected.
4. **Topological Sorting**: Provides a deterministic linear ordering of prerequisite tasks.
5. **Eligibility Resolution**: A milestone is marked `ready` if and only if all predecessor milestones are `completed`. Otherwise, it is marked `blocked`.

### 4.2 Progressive Roadmap Planner (`core/longhorizon/decomposition/progressive-planner.ts`)
- **Bounded Missions**: Milestones generate concrete `BoundedMissionProposal` instances containing scoped intents, specific capabilities, and isolated timeouts.
- **Advisory Learning**: Planners query the `LearningEngine` for verified lessons relevant to the goal's domain. Recalled insights are attached to the roadmap proposal as advisory notes (`advisoryLessonsApplied`) without bypassing verification gates.
- **Milestone Settlement**: Settling a milestone requires explicit recorded evidence (`reason`). Settling updates the roadmap revision, recalculates downstream dependency readiness, and records audit events.

---

## 5. Non-Widening Budget Hierarchy

Unbounded autonomous loops present severe risks of runaway API costs and infinite loops. Freya enforces a non-widening hierarchy:

```
Owner System Budget (Governor Ceiling)
       |
       v
Goal Budget Policy (Set at Goal Creation or Owner Top-Up)
       |
       v
Milestone / Mission Budget (Derived from Remaining Goal Budget)
       |
       v
Work Capability Step Limits (Per-Invocation Token & Action Caps)
```

### 5.1 Invariant Rules (`core/longhorizon/budget.ts`)
1. **Non-Widening Derivation**:
   \[
   \text{Requested Mission Budget} \le \text{Remaining Goal Budget}
   \]
   Deriving a mission budget with requests exceeding remaining goal capacity is clamped or rejected.
2. **Spend Accounting**: Spend is tracked across four distinct dimensions:
   - `modelCalls`: Invocations to LLM model providers.
   - `actions`: Concrete tool and work actions executed.
   - `externalRequests`: Network requests and external side-effects.
   - `missions`: Bounded mission runs started under the goal.
3. **Automatic Exhaustion Pause**: When any dimension reaches or exceeds its policy ceiling, the goal is immediately moved to `paused` with reason `budget_exhausted`.
4. **Authority Boundary Invariant**:
   - The autonomous `GoalEngine` and `ContinuationEngine` **CANNOT widen their own budget**.
   - `GoalEngine` deliberately does not expose a public `setBudget` method.
   - Budget increases require an explicit Core command (`goal.budget.set`) authenticated through Guard permission `goal.manage` by the system owner.

---

## 6. Governed Continuation Engine & Anti-Hallucination

The continuation engine (`core/longhorizon/continuation.ts`) decides what action to take when a wake occurs. It functions as a pure, governed state machine:

### 6.1 Closed Wake Causes
Continuation wakes are restricted to a closed vocabulary:
- `'scheduled_review'`: Periodic audit timer fired by LifeLoop.
- `'external_event'`: Trusted external trigger or webhook.
- `'approval_granted'`: Owner provided required human approval.
- `'prerequisite_finished'`: Predecessor milestone or mission completed.
- `'restart_recovery'`: Core started and performed startup reconciliation.

### 6.2 Wake Evaluation Pipeline
1. **Emergency Stop Override**: If `STOP ALL` is active, immediately refuse and return `wait` with `STOP ALL is active`.
2. **Spurious Wake Rejection**: If the wake contains an unregistered cause (e.g., hallucinated text from an LLM prompt), the wake is dropped and returns `wait: unregistered wake cause rejected`.
3. **Authorization Gate**: If `wake.authorized === false`, the wake is rejected with `wait: unauthorized wake source rejected`.
4. **Budget Check**: If goal budget is exhausted, return `pause: budget_exhausted`.
5. **State Guard**: If goal is `paused`, return `pause: the goal is paused`.
6. **Milestone Readiness**: If all current milestones are finished and all checkpoints verified, return `complete`. If unready milestones are blocked on prerequisites, return `wait: waiting on milestone dependencies`. If an eligible milestone exists, return `continue`.

---

## 7. Honest Restart Recovery & Anti-Fabrication Invariants

Distributed and local agentic systems frequently suffer from "restart amnesia" or, worse, "fabricated continuation" where the system claims work finished while offline. Freya guarantees **absolute restart honesty**:

### 7.1 Startup Reconciler (`reconcileAfterRecovery`)
When Freya restarts:
1. **No Fabricated Execution**: Zero model calls or tool executions are invented for the downtime period.
2. **Interrupted Work Fails**: Checkpoints that were `in-progress` when the process terminated are marked `failed` in the journal with reason `restart_interrupted`.
3. **Active Goals Pause**: Goals that were `active` are automatically transitioned to `paused` with reason `recovery`.
4. **Owner Authorization Required**: The owner must review the post-crash status and explicitly dispatch `goal.resume` before continuation wakes can proceed.
5. **Checkpoint Retries**: Interrupted checkpoints can be safely retried (`attempts: 2`) and verified once resumed, ensuring progress resumes without permanent corruption or uncoordinated duplicate checkpoints.
