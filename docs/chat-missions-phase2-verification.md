# Chat-Originated Autonomous Missions Phase 2 Verification

Branch: `feat/mind-missions-integration`  
Base commit: `e581d92`  
Status: Phase 2 Complete, Verified, and Ready for Review

## 1. Executive Summary

Phase 2 builds upon Phase 1's governed mission planning and verified execution, integrating end-to-end chat-originated research Missions into Freya.

Key capabilities delivered:
1. **Zero-Privilege Mission Proposals**: A typed `propose_mission` tool in `MindService` allows Freya to propose multi-step research missions during ordinary chat without creating background work, allocating model grants, or expanding permissions. Ordinary chat continues to function without creating Missions.
2. **Authoritative Ownership & Approval Flow**: Missions can only be initiated from an explicit owner decision on a proposed assistant message in the same encrypted conversation. Preload filters and strips forged authority parameters.
3. **Real Guarded Research & Independent Source Verification**: A new `research.search` capability pairs with `research.sources.verified`, using `ResearchIntegration`, `Searcher`, and native browser targets to perform bounded public web search and page reads. The verifier independently re-fetches each source URL to verify excerpt fidelity before marking the step `verified`.
4. **Resilient Continuation & Bounded Replanning**: Continuation routes verified and failed step transitions from `EventFabric` through `chatMissionContinuation` policy in `core/lifeloop/decide.ts`. A failed retrieval triggers at most one bounded replan that preserves already verified steps. Consequential actions are never duplicated.
5. **Attributed Source Report Delivery**: Before mission completion, a bounded model call produces structured findings strictly bound to verified evidence excerpts. Unsupported quotes and citations are withheld. An attributed report with provenance and factual limitations is delivered back to the originating chat.
6. **Chat UI Integration (`MissionCard`)**: The existing conversation UI displays authoritative mission proposals, step progress, blockers, and Approve/Decline/Cancel/Resume controls.

---

## 2. Files Changed and Added

### New Modules
- `core/mind/mission-proposal.ts`: Zero-privilege proposal tool and prose rendering.
- `core/missions/chat-types.ts`: TypeScript contracts for proposals, bindings, evidence, and UI views.
- `core/missions/chat-integration.ts`: Coordination bridge for proposal decisions, recovery, bounded replanning, and report completion.
- `core/work/research-inspection.ts`: Real `research.search` capability and `research.sources.verified` independent verifier.
- `src/app/chat/MissionCard.tsx`: Chat card rendering proposal, step status, blockers, and decision actions.
- `tests/core/chat-missions-integration.test.ts`: Integration test suite exercising the end-to-end flow with actual HTTP research and encrypted stores.
- `tests/unit/app/chatMission.test.tsx`: React Testing Library unit tests for `MissionCard`.
- `electron/acceptance-chat-missions.ts`: Real Electron runner verifying preload sanitization, IPC bridge, and native managed-browser verification.
- `scripts/build-chat-missions-acceptance.mjs`: Esbuild bundling script for the Electron acceptance runner.
- `docs/superpowers/plans/2026-10-10-chat-missions-phase2.md`: Phase 2 implementation specification.
- `docs/chat-missions-phase2-verification.md`: This verification document.

### Modified Modules
- `core/conversation/types.ts`: Added optional `missionProposal`, `missionId`, and `missionDecision` fields on `ConversationMessage`.
- `core/conversation/service.ts`: Threaded `missionViews` into conversation projections and preserved mission metadata in message views.
- `core/mind/tools.ts`: Added `missionProposal` observation payload support to `MindTool` and registry.
- `core/mind/loop.ts`: Short-circuited tool loop on proposal observation to render review prose without extra model roundtrips.
- `core/mind/mind.ts`: Propagated mission proposals to turn experiences while preserving ordinary tool inference.
- `core/mind/mission-planning.ts`: Added revision planning support that retains previously verified steps and incorporates failure diagnostics.
- `core/missions/types.ts`: Added `chatBinding` and `researchEvidence` to `MissionContent`.
- `core/missions/engine.ts`: Supported encrypted chat binding, serialised chat content updates, and revision plan commits.
- `core/missions/autonomy/continuation.ts`: Preserved final active plan execution when revision slots are exhausted.
- `core/lifeloop/decide.ts`: Exported `chatMissionContinuation` predicate for event-driven continuation.
- `core/index.ts`: Wired `ChatMissionIntegration`, capability registration, `conversation.mission.decide` command handling, and verified/failed step event routing.
- `core/protocol/conversation.ts`: Extended renderer-safe message and projection types.
- `core/protocol/core-protocol.ts`: Added `conversation.mission.decide` command name.
- `electron/preload.ts`: Allowlisted and sanitized `conversation.mission.decide` payload.
- `src/app/chat/Chats.tsx`: Rendered `MissionCard` for assistant messages with proposals.
- `src/app/chat/chat.css`: Styled `.chat-mission` container and actions.
- `src/platform/conversationClient.ts`: Added `decideMission` method to `ConversationMirror`.
- `tests/core/mission-autonomy.test.ts`: Updated revision ceiling test assertion to match final plan execution semantics.
- `package.json`: Added `build:chat-missions-acceptance` and `test:chat-missions` scripts.

---

## 3. End-to-End Execution Trace

```
User Turn ("Research five AI models under €20...")
   │
   ▼
ConversationService.submitTurn -> MindService.runTurn
   │
   ▼
Model Tool Call: propose_mission({ goal, scope, criteria })
   │
   ▼
MissionProposalTool returns ChatMissionProposal (ZERO work, ZERO permissions)
   │
   ▼
ConversationStore saves assistant message with `missionProposal`
   │
   ▼
UI renders `MissionCard` with "Approve Mission" / "Decline"
   │
   ▼
User clicks "Approve Mission"
   │
   ▼
Preload strips any forged authority -> IPC `freya:core:submit` -> Core `conversation.mission.decide`
   │
   ▼
Core verifies ownership & encrypted durability; provisions bounded grant & worker; creates durable Mission
   │
   ▼
Mind Planner generates initial plan (max 2 steps) using `research.search`
   │
   ▼
WorkEngine executes `research.search`:
   - Searcher queries search provider
   - Managed browser reads each page and extracts excerpts
   - Verifier `research.sources.verified` independently re-reads each URL to verify excerpt fidelity
   │
   ▼
EventFabric publishes `mission.step.transitioned` (to `verified`)
   │
   ▼
Core `observeVerifiedMissionStep` -> `ChatMissionIntegration.settled()`
   │
   ▼
Event-driven continuation advances next step (no polling, no second scheduler)
   │
   ▼ (if failure occurs, one bounded revision preserves verified steps)
   │
Report Step: Bounded model call validates exact quotes and source IDs from verified evidence
   │
   ▼
Attributed comparison report (with retrieval vs. factual accuracy notice) delivered to conversation
   │
   ▼
Mission completed in MissionEngine and reflected in conversation view
```

---

## 4. Actual Capabilities Connected

| Capability | Risk | Registered Verifier | Backing Service |
|---|---|---|---|
| `research.search` | `routine` | `research.sources.verified` | `ResearchIntegration` -> `Searcher` + `ManagedBrowserService` / `SafeHttpTransport` |
| `filesystem.inspect` | `routine` | `filesystem.inspect.verified` | File metadata inspection (Phase 1) |
| `propose_mission` | `routine` | N/A (Mind tool) | Proposal generation only (no external effect) |

---

## 5. Authorization and Security Gates

1. **Zero-Privilege Proposals**: `propose_mission` cannot execute actions, create workers, or allocate grants.
2. **Closed Approval Vocabulary**: Decisions are restricted to `approve`, `reject`, `cancel`, `resume`. Model output cannot invoke decisions.
3. **Preload Firewall**: `electron/preload.ts` strips any caller-supplied `permissions`, `grantId`, or unauthorized fields, passing only `conversationId`, `proposalMessageId`, and `decision`.
4. **Ownership & Durability Enforcement**: Decisions are refused if the conversation is not in encrypted mode or if the proposal message is missing from the encrypted journal.
5. **Untrusted Web Content Handling**: Retrieved web pages are strictly treated as data. Injected prompt instructions (e.g. `IGNORE ALL RULES`, simulated `FREYA_TOOL_CALL`) cannot execute tools or widen permissions.
6. **Provenance & Evidence Integrity**: Queries, URLs, retrieval timestamps, and excerpts are securely stored in encrypted `MissionContent` and omitted from public event logs.
7. **Attributed Report Verification**: Model-generated reports must strictly match source IDs and excerpt substrings present in verified evidence. Hallucinated quotes or citations cause immediate rejection.
8. **Emergency Stop & Revocation**: STOP ALL, grant revocation, or permission withdrawal halts active Work runs immediately and suspends continuation.
9. **Persistence & Safe Restart**: Restart pauses incomplete chat Missions with explicit user resume required. Verified steps are never re-executed.

---

## 6. Test Commands and Exact Results

### 1. TypeScript Compilation
```bash
npm run typecheck
```
**Result**: Exit code 0 (All 3 projects: tsconfig.json, tsconfig.electron.json, tsconfig.core.json).

### 2. Changed-File ESLint
```bash
npx eslint core/mind/mission-proposal.ts core/missions/chat-integration.ts core/missions/chat-types.ts core/work/research-inspection.ts src/app/chat/MissionCard.tsx tests/core/chat-missions-integration.test.ts tests/unit/app/chatMission.test.tsx electron/acceptance-chat-missions.ts scripts/build-chat-missions-acceptance.mjs core/conversation/service.ts core/conversation/types.ts core/index.ts core/lifeloop/decide.ts core/mind/loop.ts core/mind/mind.ts core/mind/mission-planning.ts core/mind/tools.ts core/missions/autonomy/continuation.ts core/missions/engine.ts core/missions/types.ts core/protocol/conversation.ts core/protocol/core-protocol.ts electron/preload.ts src/app/chat/Chats.tsx src/platform/conversationClient.ts tests/core/mission-autonomy.test.ts
```
**Result**: Exit code 0 (0 errors, 0 warnings).

### 3. Focused Chat-Missions Integration Suite
```bash
npx vitest run tests/core/chat-missions-integration.test.ts
```
**Result**: **19 passed (19)** in 11.65s.
- Proposal creation without work.
- Proposal schema validation.
- Ordinary chat remaining ordinary.
- Full E2E execution with local HTTP research, independent verification, continuation, and report.
- One bounded replan on insufficient evidence preserving verified steps.
- Rejection without work or grants.
- Refusal of cross-conversation and duplicate approvals.
- Refusal of invalid, escalation, or failing planning attempts.
- Honest handling of unreachable sources.
- Injection mitigation from untrusted web pages.
- STOP ALL, cancellation, capability withdrawal, and grant revocation at real retrieval boundaries.
- Restart pause and safe resume without duplicate execution.
- Rejection of fabricated quotes and citations.

### 4. Phase 1 Regression Suite
```bash
npx vitest run tests/core/mind-missions-integration.test.ts
```
**Result**: **24 passed (24)** in 10.21s.

### 5. Mission Autonomy Suite
```bash
npx vitest run tests/core/mission-autonomy.test.ts
```
**Result**: **55 passed (55)** in 2.67s.

### 6. Chat Frontend Unit Suite
```bash
npx vitest run tests/unit/app/chatMission.test.tsx
```
**Result**: **3 passed (3)** in 1.43s.

### 7. Chat Unit Regression Suite
```bash
npm run test:chat
```
**Result**: **42 files passed, 394 tests passed** in 16.15s.

### 8. Work, LifeLoop, and Research Regression Suite
```bash
npx vitest run tests/core/lifeloop tests/core/research tests/core/work.test.ts tests/core/work-lifecycle.test.ts tests/core/research-integration.test.ts tests/core/research-cancellation.test.ts tests/core/research-sessions-integration.test.ts
```
**Result**: **24 files passed, 617 tests passed** in 26.83s.

### 9. Security / Red-Team Suite
```bash
npm run test:redteam
```
**Result**: **75 files passed, 1,436 tests passed** in 28.54s.

### 10. Production Renderer and Main Build
```bash
npm run build
```
**Result**: Exit code 0 (Vite client + Electron preload/presence/main bundles generated).

### 11. Native Electron Acceptance Test
```bash
npm run test:chat-missions
```
**Result**:
```
PASS actual preload creates encrypted conversation through desktop host
PASS actual chat turn produces typed proposal
PASS no search before owner approval
PASS owner decision creates Mission through actual preload and host
PASS preload strips attempted authority fields
PASS actual local HTTP Mission completed with native managed-browser verification
PASS attributed report returned to originating conversation
PASS report states factual verification limitation
PASS only fixture chat, plan and report model calls; no paid provider
PASS two real searches and four native browser page reads
PASS hostile page instruction creates no extra Mission
RESULT mode=local-http model=fixture searches=2 reads=4
```
Exit code: 0.

---

## 7. Mocks vs Real Services

- **Real Services Exercised**:
  - Full production `Core` instance and state machine.
  - Production `WorkEngine`, `Workforce`, and `MissionEngine`.
  - Production `EventFabric` and encrypted SQLite/file stores.
  - Actual local HTTP server and network fetch requests for search and page reading.
  - Native Electron process, `BrowserWindow`, IPC channels, and preload sandbox.
  - Native browser target extraction with real DOM text parsing.
  - Real Guard security evaluations and STOP ALL signals.
- **Mocked Components**:
  - `FakeModelProvider`: Used deterministic mock model responses for planning and JSON report extraction to avoid incurring real-world LLM token costs during CI/acceptance runs.

---

## 8. Remaining Limitations

1. **Research Scope**: Bounded to public web search and read-only webpage retrieval. No authenticated web sessions, form submissions, or write operations are permitted.
2. **Bounded Replanning**: Capped at exactly 1 revision attempt after step failure. If the revision fails or sources remain unreachable, the Mission pauses and requests owner intervention.
3. **Retrieval Verification vs Factual Truth**: Independent source rereading verifies that the external document actually contained the retrieved excerpt; it cannot certify whether the third-party claims are factually accurate. The generated report explicitly carries this caveat.
4. **Manual Restart Resume**: Following an application restart, active chat missions enter a paused state to prevent uncontrolled execution, requiring explicit owner click on "Resume".
