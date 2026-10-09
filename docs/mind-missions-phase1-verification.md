# Mind and Missions Phase 1 verification

Branch: `feat/mind-missions-integration`, based on `ac379cc`. No merge into main. Implementation and review performed in this chat without subagents.

## Production flow and confirmed gaps

`conversation.turn.submit` → `ConversationService.submitTurn` → `MindService.runTurn` → OwnerAuthority/CognitionService → Guard/Governor → ModelGateway is the existing conversation path. It does not automatically create Missions.

`mission.create` → encrypted MissionStore + metadata EventFabric → MissionEngine is the existing durable goal path. `readyMission`/`advanceMission` reach MissionAutonomyRuntime. Its legacy proposal chooses a low-risk capability without interpreting the goal. The original Core executor supplied `{expect: stepId}` to every capability. Work already had independently registered capabilities/verifiers, Guard authorization, approvals, cancellation, and recovery. Mission completion separately verifies child Runs, step statuses and evidence.

LifeLoop already receives authoritative events, but has no MissionAutonomy advancement port. Executive and LongHorizon remain independent scheduling domains. LearningEngine exists separately and is not composed by Core. These gaps are addressed narrowly rather than replacing their architectures.

## Implemented path and ownership

The trusted host creates a goal using existing `mission.create`, supplies an existing mission-scoped background cognition grant, and calls `Core.planMissionGoal({missionId, grantId, continueAfterVerification})`. It then invokes the existing `advanceMission(id, 'manual')` once to start execution. Successful verified events can advance later decisions without another user instruction.

| Responsibility | Owner in this slice |
| --- | --- |
| Goal interpretation / proposed strategy | Mind planning service, one explicitly authorized Cognition request using the configured model path |
| Plan schema and capability/dependency validation | Strict JSON parsing, existing deterministic planner, registry-owned risk/verifier bindings |
| Durable goal, plan metadata, spend and evidence | MissionEngine and existing encrypted MissionStore/EventFabric |
| Next eligible action | Existing bounded MissionAutonomyRuntime decision |
| Delegation | Existing Workforce roster and assignment limits; no worker creation |
| Execution and action authorization | WorkEngine and current Guard authority |
| Step verification | Independently registered filesystem verifier re-inspects real file metadata |
| Mission completion | Existing verified-child-Work Mission verifier |
| Continuation | Core's existing EventFabric subscription delivers a newly verified step to one bounded MissionAutonomy decision, only for an opted-in private plan |
| Model grants, approvals and financial authority | Existing OwnerAuthority/Governor/Guard and Work approval surface; the planner cannot grant or approve anything |

`filesystem.inspect` is registered by production Core when trusted `missionReadRoots` are configured. With no roots, it is absent. It only observes a regular file's size, modification time and inode. It resolves actual paths against roots captured at registration, rejects junction/symlink escapes and later root redirects, checks cancellation and returns generic errors. It reads no file contents, writes no files and launches no shell.

Private task intent and execution inputs are encrypted alongside the goal, before metadata plan commitment. Planning requires both durable event history and encrypted goal content; temporary fallback storage refuses this path. The executor checks plan ID, step ID, capability and verifier bindings before supplying those inputs to Work. Missing or mismatched real inputs refuse execution. A failed intelligent planning attempt cannot invoke the legacy fixture planner. Legacy fixture workflows remain compatible; the new proposal service rejects all `test.*` capabilities.

Continuation makes no model calls, uses no polling and retries no failed steps automatically. Existing mission/action/delegation/deadline ceilings still apply. STOP ALL and current Guard permission checks win before further execution. EventFabric replay never publishes events, so startup does not execute saved steps. A manual continuation after restart uses encrypted inputs for the next pending step and leaves verified steps alone. Owner intent correction invalidates the old private execution plan.

## Contracts and files

Added `MissionGoalRequest`, `MissionPlanningInput`, `MissionExecutionPlan` and discriminated `MissionGoalOutcome`. Reused `PlanStepRequest`, `MissionPlanRecord`, `MissionCapabilityPort`, `CognitionIntent/Outcome`, `WorkCapabilityRequest/Result`, `WorkObservationContent`, `WorkVerificationRequest/Outcome`, `DecisionTrigger`, and the existing `mission.step.transitioned` event. No new public journal or renderer protocol.

| File | Change |
| --- | --- |
| `core/mind/mission-planning.ts` | Bounded cognition proposal, strict schema, code-owned bindings and deterministic validation |
| `core/work/file-inspection.ts` | Real read-only capability and independent verifier |
| `core/missions/types.ts` | Optional encrypted execution plan content |
| `core/missions/engine.ts` | Private content access/persistence, conditional metadata commitment, correction invalidation |
| `core/index.ts` | Trusted API, capability registration, budgets/authorization, real inputs, verified-event continuation |
| `tests/core/mind-missions-integration.test.ts` | Production Core/Work/storage integration and safety checks |
| `docs/superpowers/plans/2026-10-09-mind-missions-integration.md` | Architecture trace and implementation plan |
| `docs/mind-missions-phase1-verification.md` | This report |

No Electron, tray, character, dashboard, voice, dependency or backend architecture rewrite changes.

## Verification

Verified on Windows using actual production Core, WorkEngine, Workforce, EventFabric, filesystem IO and encrypted MissionStore. Only model proposal responses were mocked. The permission-withdrawal test changes the actual principal's capability set and uses the real Guard. A real Windows junction escape is tested. No paid or live model call was made.

- Initial new integration test failed because `planMissionGoal` was missing; it passed after implementation.
- Final focused integration suite: **24 tests passed**. Covers structured natural-goal proposal, dependencies/code-owned bindings, two actual inspections, independent metadata verification, unknown/test capabilities, invalid schema, malformed/truncated/provider failures, missing grants, missing encrypted durability, real journal-open failure/temporary storage, planning concurrency, action/model budgets, principal permission withdrawal, outside-root access, real junction escape/root redirects, failed actions, STOP ALL during planning and between steps, explicit continuation opt-in, encrypted restart persistence, and no completed-step replay.
- Relevant Missions, Work, Workforce, Cognition, LifeLoop, LongHorizon and adversarial regressions: **1,099 tests passed in 33 files**. This run includes an earlier version of the focused suite.
- Subsequent integration/Mission correction/loop, Vault Mission and Learning compatibility checks: **138 tests passed in 6 files**.
- Final integration and existing Mission loop/Core/correction checks: **104 tests passed in 4 files**.
- Full project typecheck: passed. Changed-source/test lint: passed. Existing renderer and Electron build: passed. Diff whitespace check: passed.
- The broad suite emitted file-handle garbage-collection warnings from existing fixtures; the build emitted a browser externalization warning for existing research code. Neither check failed.

The actual integration demonstrates one model proposal, two real verified Work Runs, Mission completion, unchanged file contents, private inputs absent from public journals, and persisted state after a fresh Core start. It is not a live-LLM quality test. Electron was built but not launched for this backend-only phase. Full repository lint and the entire repository test suite were not run for this change.

## Limits and next slice

This is a trusted Core integration boundary. The existing desktop/chat host does not yet configure read roots or expose `planMissionGoal`; ordinary chat continues unchanged. A capable existing Workforce worker, durable mission encryption, configured read roots and a valid scoped grant are prerequisites. Planning does not start execution until the host makes the first explicit bounded advance.

Only file metadata inspection is newly connected. No research, report creation, notifications, unrestricted terminal access, file-content reading, automatic money spending, autonomous replanning or Learning ingestion is implemented. Verification proves real metadata inspection and dependency completion; it does not prove arbitrary natural-language success criteria or semantic planning quality. Failed planning/corrected plans need owner intervention and a new goal in this first slice. Interrupted or uncertain actions are not automatically resumed. Continuation currently uses EventFabric directly; broader LifeLoop attention/cooldown policy integration remains future work.

Next: add a narrow explicit chat-to-Mission handoff with owner-visible scope/grant choices and result delivery, then connect one existing research capability with independent source verification. Replanning should consume verified observations under a separate bounded grant. Later learning should admit independently verified Work outcomes through existing VerifiedOutcome/LearningExperience admission, retaining provenance/freshness and treating model plans as proposals, never facts.
