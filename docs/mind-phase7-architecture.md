# FREYA MIND — Phase 7 Architecture
## Advanced Self-Improvement, Metacognition and Verified Evolution

**Date**: 2026-10-10  
**Branch**: `feat/mind-phase7-verified-evolution`  
**Status**: Implemented & Verified  

---

## 1. Executive Summary

Phase 7 completes the Freya Mind rebuild by endowing Freya with **empirical, verified self-improvement**. Rather than merely accumulating anecdotal memories or claiming to improve through ungrounded LLM self-evaluation, Freya observes her own empirical execution history, identifies recurring performance weaknesses, formulates testable strategy hypotheses, runs controlled experiments under strict resource ceilings, independently evaluates outcomes against frozen criteria, requires explicit owner approval for promotion, continuously monitors active strategies for regressions, and rolls back safely when regressions occur.

### Non-Negotiable Invariants

1. **A learning claim is not an improvement**: Recording an experience does not prove that subsequent execution is more capable or efficient.
2. **An improvement proposal is not permission to apply it**: Generating an alternative heuristic does not authorize modifying active behavior.
3. **A successful experiment is not proof of general improvement**: Isolated success on known inputs does not prove generalizability; holdout evaluations must test for overfitting.
4. **A model's self-evaluation is not independent verification**: Candidate strategies cannot score their own outcomes or redefine success criteria.
5. **Self-improvement increases useful capability, never authority or permissions**: Freya's desire to improve cannot expand Guard rules, Governor budgets, permissions, or system access.
6. **Promoted strategies must be reversible**: Every active strategy retains a deterministic rollback mechanism and is monitored for performance decay.
7. **Deterministic metrics cost zero model tokens**: Aggregating durations, error counts, retry attempts, and success rates uses pure TypeScript logic. Missing telemetry is explicitly `null`, never hallucinated.

---

## 2. Subsystem Ownership & Architectural Topology

Phase 7 integrates directly into the unified Freya Core without duplicating existing execution, planning, or storage engines:

```
+---------------------------------------------------------------------------------------------------+
|                                            FREYA CORE                                             |
|                                                                                                   |
|  +--------------------+        Execution Telemetry        +-----------------------------------+   |
|  |    Work Engine     | ================================> |        PerformanceObserver        |   |
|  | (Missions / Tasks) |                                   | (Attribution, Zero Token Metrics) |   |
|  +--------------------+                                   +-----------------------------------+   |
|                                                                             |                     |
|                                                                             v                     |
|  +--------------------+         Recurring Defects         +-----------------------------------+   |
|  |     EventFabric    | <================================ |        WeaknessClassifier         |   |
|  |  (Audit Journal)   |                                   |  (Statistical Restraint >= 2)     |   |
|  +--------------------+                                   +-----------------------------------+   |
|                                                                             |                     |
|                                                                             v                     |
|  +--------------------+        Hypothesis Proposal        +-----------------------------------+   |
|  |   Candidate Store  | <================================ |     Candidate Strategy Design     |   |
|  | (Encrypted Vault)  |                                   | (Boundary Check: 0 Security Mod)  |   |
|  +--------------------+                                   +-----------------------------------+   |
|                                                                             |                     |
|                                                                             v                     |
|  +--------------------+         A/B Evaluation            +-----------------------------------+   |
|  |  Holdout Scenarios | --------------------------------> |    ControlledExperimentRunner     |   |
|  |  (Anti-Overfitting)|                                   | (Independent Verification Seam)   |   |
|  +--------------------+                                   +-----------------------------------+   |
|                                                                             |                     |
|                                                                             v                     |
|  +--------------------+       Owner Authorization         +-----------------------------------+   |
|  |  Attention Domain  | <================================ |     StrategyLifecycleManager      |   |
|  | (Promotion Notice) |                                   | (State Machine, Rollback, Monitor)|   |
|  +--------------------+                                   +-----------------------------------+   |
|                                                                             |                     |
|                                                                 Active Strategy Registry          |
|                                                                             v                     |
|  +--------------------+                                   +-----------------------------------+   |
|  |   Planning Engine  | <================================ |     Active Production Strategies  |   |
|  | (Decomp / Sources) |                                   | (Reversible, Supervised Runtime)  |   |
|  +--------------------+                                   +-----------------------------------+   |
+---------------------------------------------------------------------------------------------------+
```

| Subsystem | File Path | Phase 7 Responsibility |
|---|---|---|
| **Metacognition** | `core/metacognition/` | Ingests execution telemetry, attributes failures across 5 orthogonal categories, detects recurring weaknesses, and provides zero-model-token metacognitive reports. |
| **Evolution Hypotheses** | `core/evolution/strategy.ts` | Formulates structured `StrategyCandidate` proposals from weaknesses; strictly forbids modifications to authority, Guard, Governor, secrets, or source code. |
| **Controlled Experimentation** | `core/evolution/experiment.ts` | Executes side-by-side A/B evaluations on training and holdout scenarios; independently verifies outcomes with frozen criteria and hard budget ceilings. |
| **Strategy Lifecycle** | `core/evolution/lifecycle.ts` | Enforces governed state transitions (`proposed` -> `evaluated` -> `promotion_pending` -> `active` -> `rolled_back`); requires explicit owner approval for promotion; monitors regressions. |
| **Vault Persistence** | `core/vault/repositories/` | Persists metacognition telemetry and strategy candidates durably into encrypted SQLCipher storage (`domain = 'metacognition'` and `domain = 'evolution'`). |

---

## 3. Phase 7A — Metacognition & Performance Awareness

### 3.1 Failure Attribution Taxonomy
When a mission or action step fails, attributing failure to Freya's strategy without analyzing causality produces false hypotheses. Freya classifies every observed failure into five distinct categories:

1. `environmental`: Network unreachable, DNS timeout, disk full, host OS process interruption.
2. `tool_outage`: External API 502/503/504, rate limit, provider schema change.
3. `external_denial`: Permission denied, sandbox violation, token authorization expired.
4. `strategy_defect`: Ineffective task decomposition, poor source selection, repeated failed queries, excessive replanning loops.
5. `model_misdirection`: Instruction drift, hallucinated parameters, output schema violation.

**Only `strategy_defect` patterns are eligible to trigger improvement hypotheses.**

### 3.2 Statistical Restraint & Weakness Classification
An isolated failure is an anomaly, not a systemic defect. The `WeaknessClassifier` enforces strict statistical guardrails:
- A weakness requires at least **2 recurring occurrences** under comparable conditions.
- Hypotheses will not be generated for external, environmental, or denial errors.
- Every weakness record retains explicit links to the underlying `observationIds`.

### 3.3 Metacognitive Reporting (Zero Model Calls)
Freya answers core metacognitive queries deterministically:
- `whatAreYouStrugglingWith()`: Lists active weaknesses with observation counts.
- `whatMistakesDoYouKeepMaking()`: Identifies recurring error patterns.
- `whatHaveYouImproved()`: Reports active promoted strategies with empirical improvement deltas.
- `whatEvidenceSupportsThat(candidateId)`: Returns exact baseline vs candidate metric comparisons.
- `whichImprovementsFailed()`: Lists rejected or rolled-back candidates.
- `areYouBecomingMoreEfficient()`: Computes historical aggregate efficiency trends.
- `whatShouldWeImproveNext()`: Prioritizes active weaknesses by frequency and impact.

Missing telemetry fields are represented explicitly as `null`, guaranteeing zero metric fabrication.

---

## 4. Phase 7B — Hypothesis Generation & Strategy Design

### 4.1 Strategy Candidate Schema
Every improvement candidate is a concrete, immutable specification:
- `candidateId`: Unique identifier (`cand-<timestamp>-<slug>`).
- `associatedWeaknessId`: Foreign key to verified weakness.
- `targetScope`: Strategy scope (e.g. `research_source_ranking`, `task_decomposition`, `context_retrieval_ranking`).
- `baselineStrategy`: Specification of current behavior.
- `proposedStrategy`: Specification of alternative heuristic/ranking.
- `measurementCriteria`: Frozen array of metrics (duration, error rate, tokens, actions).
- `evaluationCriteria`: Minimum pass rate, maximum error rate, regression thresholds.
- `experimentBudget`: Hard ceilings for trial runs (max tokens, max runs, timeout).
- `rollbackPlan`: Deterministic rollback strategy with target baseline version.

### 4.2 Prohibited vs Allowed Modifications

#### Strictly Prohibited (Hard Code Rejection)
Any candidate that attempts to modify any of the following is immediately rejected by `validateCandidateProposal`:
- Guard authority rules or permission grants.
- Governor hard financial/token spending limits.
- Owner approval workflows or bypass logic.
- Authentication, cryptography, and Vault secret handling.
- Production source code modification.
- Epistemic verification standards (cannot lower verification thresholds).

#### Allowed Strategy Scopes
- Research source ranking and filtering heuristics.
- Context retrieval prioritization and token pruning heuristics.
- Task decomposition and step sequencing templates.
- Non-security scheduling heuristics and tool selection preferences.

---

## 5. Phase 7C — Controlled Experimentation & Independent Evaluation

### 5.1 A/B Comparative Runner
The `ControlledExperimentRunner` evaluates candidate strategies against baseline behavior across identical scenarios:
- **Baseline Run**: Standard heuristics applied to scenario.
- **Candidate Run**: Proposed heuristics applied to identical scenario.
- **Metrics Collected**: Duration (ms), token consumption, action count, error rate, verification pass/fail.

### 5.2 Independent Verification Seam
Candidates are strictly isolated from the evaluation verdict:
- **Frozen Criteria**: The runner locks measurement criteria before scenario execution begins.
- **Independent Judge**: Verification logic inspects raw outputs using invariant assertions (`independentlyVerifyScenarioResult`); the candidate has zero capability to alter criteria or self-score.
- **Sample Size Gate**: A minimum of 3 scenario runs is required to establish statistical validity. Fewer than 3 runs yields `outcome = 'inconclusive'`.

### 5.3 Overfitting Prevention via Holdout Evaluation
Candidates must succeed not only on scenarios derived from historical failures, but also on **unseen holdout scenarios**.
- If a candidate achieves 100% on training scenarios but drops below the pass rate on holdouts (e.g., stale domain bit-rot), the evaluation concludes `outcome = 'rejected'` due to overfitting.

---

## 6. Phase 7D — Governed Strategy Lifecycle & Promotion

### 6.1 State Machine
Strategy candidates progress through a governed, irreversible-forward state machine:

```
[proposed] ──> [evaluating] ──> [evaluated] ──> [promotion_pending] ──> [active] ──> [rolled_back]
                     │               │                    │
                     └── [failed]    └── [rejected]       └── [rejected]
```

### 6.2 Mandatory Owner Approval for Production Promotion
Even if an experiment demonstrates a 50% improvement with 0 errors:
- Freya **cannot autonomously promote** the strategy into active production status.
- Promotion requires an explicit `promoteCandidate()` call containing:
  - `authorizedBy: 'owner'`
  - `approvalId`: Non-empty reference to owner sign-off.
- Unauthorized calls (e.g. from subagents, background jobs, or missing approvals) are immediately refused (`code: 'unauthorized'`).

### 6.3 Active Strategy Registry & Production Wiring
- When promoted, the candidate is registered in the `ActiveStrategyRegistry`.
- Subsystems (such as research planners) query `evolution.getActiveStrategy(scope)` to resolve the active heuristic.
- If no active strategy exists for a scope, the hardcoded baseline heuristic executes.

### 6.4 Regression Monitoring & Automatic Rollback
- The `StrategyLifecycleManager` monitors real production executions using the active strategy.
- If error rates increase beyond the candidate's `regressionThreshold` or verification failures occur, the manager automatically executes the `rollbackPlan`.
- The strategy status transitions to `rolled_back`, the previous baseline heuristic is restored, and an audit event (`evolution.candidate.rolled_back`) is appended to the EventFabric.

### 6.5 Multi-Session Durability
- Strategy records and promotion history are durably stored in the SQLCipher Vault (`domain = 'evolution'`).
- Upon Core restart, `strategyLifecycle.initialize()` restores active strategies and resumes regression monitoring seamlessly.
