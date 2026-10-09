# Freya Chat Evolution — 8 Phases: implementation brief

## Phase progress (2026-10-09)

| Phase | Status | Tests | Commit |
|---|---|---|---|
| 1. Chat Shell | Complete | 372 focused tests; full TypeScript; scoped lint; renderer/desktop build; live provider and restart checks | `295b436` |
| 2. Rendering | Complete | 567 focused tests; full TypeScript; scoped lint; renderer/desktop build; live rich formats, copy and encrypted restart | `ec85393` |
| 3. Research | Complete | 835 focused tests; full TypeScript; scoped lint; both builds; real search, source follow-up and encrypted restart | Scoped research commit |
| 4. Right Workspace | Not started | — | — |
| 5. Composer | Not started | — | — |
| 6. Agentic Execution | Not started | — | — |
| 7. Voice & Multimodal | Not started | — | — |
| 8. Integration | Not started | — | — |

### Phase 1 audit and implementation sequence

Shipping entry: `src/app/entry.tsx`, `HomeDashboard`, `ChatHistory`, `Chats`.
Existing: shared Core conversation mirror, encrypted/Vault storage, fresh chat,
explicit history selection, archive, persistent workspace layers, Browser and Canvas.
Preserve these foundations and the existing dashboard/orb design.

- [x] Add regression coverage for late snapshot races, connection failures, and refused navigation.
- [x] Fix the shared mirror's attach lifecycle without creating a second store.
- [x] Add history title search and an inline rename form; Core validates, stores and journals rename metadata.
- [x] Add a keyboard/pointer resize handle scoped to Chat; other screens retain their existing dimensions.
- [x] Distinguish connecting, unavailable, stopped and working states; expose retry and persistence faults.
- [x] Run focused UI/Core tests, all TypeScript checks, scoped lint and desktop build.
- [x] Verify in the isolated visible feature instance explicitly approved by the user on port 9235.
- [x] Restore the workspace's selected older conversation after Core starts; verify full restart, renamed title and message identities.
- [x] Commit only verified work on `feature/chat-evolution-8-phases`; record remaining acceptance gaps.

Execution is inline in this visible conversation, as explicitly requested. No subagents,
new worktrees or new branches. The user later explicitly approved one visible feature
instance on port 9235 with an isolated test profile. The original 9234 instance runs
the original checkout and cannot accept this worktree's changes. Tests use a worktree-local
temporary directory and Vite's runner config loader because `node_modules` is a junction.

### Phase 1 evidence and limitations

The copied `.env` is ignored by Git; values are never logged. After restart, actual
Core reports cognition available and encrypted persistence, with MiniMax-M3 selected.
`scripts/chat-shell-acceptance.mjs` operates Freya controls only and verifies new chat,
rename, a real provider reply stored by Core, switch/search, native pointer and keyboard
resize, screen continuity and unchanged dashboard orb center. Evidence is in the ignored
`artifacts/live-visible/chat-evolution/phase1.json` and screenshots. A separate full
restart check in `restart.json` confirms an older selected conversation, renamed title,
and all transcript message identities survive. Cold start still lands on Home.
Composer bounds were also checked at 1280×800 and 1024×768.

The broader Mind suite has three failures (one-call grant bound, concurrent recalled
context, fresh weather without retrieval). The same failures reproduce using the
original Mind source via a scratch transform, so they are recorded as baseline failures.
They are not counted as passing. Renderer build also retains existing `node:net`
externalization and large-chunk warnings.

### Phase 2 audit and implementation sequence

Reuse `RichMessage`, `AssistantMessageView`, typed `MediaGrid`/`ChartView`,
`AnswerActions`, and the existing browser link seam. Markdown/code/table/TOC,
copy/read-aloud, role styling, images and chart payloads already exist. Core does
not currently project token chunks; preserve its real working state rather than
simulate streaming.

- [x] Add failing renderer regressions for steps-only turns and unverified prose footers.
- [x] Use the existing assistant renderer for every assistant message, retaining media citations.
- [x] Build execution trace exclusively from typed steps, honoring executed/outcome without calling every tool a lookup.
- [x] Show old prose footers as unverified text, never trusted execution or source cards.
- [x] Wire numbered citations to actual typed source ranks and keep source actions in Freya's browser seam.
- [x] Preserve typed sources/charts/canvas in the existing Vault message transaction; migrate existing rows without recovering claims from prose.
- [x] Verify rich formats, real provider rendering, copy, typechecks, scoped lint and build; review inline and commit.

Live acceptance exposed Vault's missing artifact columns. Migration 7 adds one nullable
typed-artifacts column inside the existing encrypted database. Its decoder checks
closed field shapes, URLs, numeric points and existing Mind size limits. Old messages
retain null metadata. A SQL round-trip/reopen regression and a version-6 migration
check cover this gap. The first live formatting prompt also exposed a separate
research-router limitation: a negated “web search” phrase triggers a search. Track
negation handling in Phase 3; do not claim that request avoided retrieval.

### Phase 2 evidence and limitations

The real provider produced a heading, fenced JSON and table in one turn, followed
by an actual `make_chart` call with A=2, B=4, C=3 in the same conversation. Core's
typed execution record reports that tool ran successfully; the UI renders three
bars. Missing or malformed chart input now records a failed call rather than a
successful empty chart. Valid point arrays retain the existing request-size budget
instead of being truncated at the shorter default argument limit.

The feature browser denies the Clipboard API even with focus. Answer/code actions
now try their existing selection-based fallback on that denial and confirm success
only when a copy method succeeds. Regression tests cover denial with both successful
and refused fallback, and the live application confirms both answer and code copy.
No permission policy was changed.

`scripts/chat-rendering-acceptance.mjs` supports a new real-provider conversation,
`--existing` verification without sending a replacement turn, and `--restored`
verification after a full feature restart. The final restart preserves the selected
conversation, every message identity, chart values and actual tool records in the
encrypted Vault. Evidence: `artifacts/live-visible/chat-evolution/phase2.json`,
`chat-rendering.png`, and `chat-rendering-chart.png` (ignored local artifacts).

Validation: 53 files / 567 tests pass across UI, chat semantics, native Vault,
tool-loop truth and chart tools; all three TypeScript projects, scoped ESLint,
diff checks and both builds pass. SQLCipher wrong-key diagnostics occur in expected
negative tests. The three previously recorded broader Mind failures and build
warnings remain baseline limitations. Live media/attachments, research context,
and browser execution integration belong to the later phases; this iteration does
not claim full eight-phase acceptance. Next: Phase 3 research context resolution,
negation routing, typed source continuity and real retrieval failure handling.

You are Codex WORKING DIRECTLY on the Windows local repo in this newly created dedicated worktree:
C:\Users\you\Desktop\AI\Freya-chat-evolution
Branch: feature/chat-evolution-8-phases, derived from local main at commit 8b4aed6 (the latest at task start).
This is an implementation assignment, NOT merely an audit, prompt draft, mockup, or plan.

## Invariants
- Work ONLY in this dedicated worktree. Never edit, switch, merge, push or reset main or other Freya worktrees. No destructive git actions or worktree deletion. Keep this branch isolated.
- Preserve the existing Freya orb and dashboard appearance, security/Vault architecture, conversations, Mind, browser service, approval gates, voice, and existing UI capabilities. Evolve existing Chat rather than rebuild or introduce duplicate routing/shells.
- No fake browser/research/tool actions. Chat should distinguish streamed/provider/model narration from actual verified tool execution; use existing structured steps.
- Never make unsafe external spending/network actions, delete user data, expose secrets, or weaken authorization.
- Only one Codex lane. Do not launch other agents. Use existing repo and node_modules. Favor incremental composable changes with focused tests and real UI checks where feasible.
- Commit verified work on THIS branch in scoped commits. Don't merge to main and don't push without instruction.
- Don't get stuck in an analysis loop. After inspecting relevant existing code/tests for Phase 1, implement actual Phase 1 with tests. Continue into Phase 2 if completed and verified, but no need to start all eight prematurely.
- Include the phase plan and actual progress in docs/chat-evolution-8-phases.md (create if absent; if present honor it).

## Target program — eight phases IN ORDER
1. Chat Shell & Navigation: coherent premium Chat layout using existing app shell; reliable new chat, conversation history/select/switch, session continuity, Chat drawer/panel and empty/loading/error states; responsive window composition; preserved centered orb outside Chat, no sidebar movement that disturbs it. Do not duplicate store/services.
2. Premium Conversation Rendering: readable message hierarchy, properly separated user/assistant, Markdown, code, structured sources, images, attachments, charts, real tool-step truth, actions such as copy; avoid invented data and preserve typed renderers.
3. Perplexity-Style Research: real Web Search, research citations/sources, multi-source answer previews and follow-up workflow, same-thread context reference resolution, real URL/tool outcomes and graceful provider/network failures.
4. Universal Right Workspace: one consistent right-hand workspace for Browser, Canvas, Documents, Images, Media, sources and agent output, preserving existing Browser Service and docking instead of implementing a second browser.
5. Advanced Composer: attachment drag/drop, validation, upload/preview, model selection, thinking/Fast/Deep, contextual tool toggles, keyboard behavior and send/cancel state; existing Core remains authority for actions.
6. Agentic Execution Experience: distinguish submitted/thinking/tool running/approval/verification/complete/failed/cancelled, show authenticated step records and progress, verified browser status, stop/resume behavior, no fake completion.
7. Voice & Multimodal Chat: integrate current voice settings, provider/model choices, wake/voice UX, audio/file/image previews and existing STT/TTS integrations with real availability/failure states.
8. Full Integration & Live Acceptance: one conversation performs model conversation, real research, attachment, browser tab action, verification and follow-up; browser actions MUST be Freya tools, while UI automation may only operate Freya itself. Run regression tests, TypeScript, lint where scoped, build, and provide evidence. Do not claim success on blocked external network.

## CURRENT ITERATION (perform actual code)
- First, inspect startup.md, existing chat screens/components, routes/state/hooks, relevant unit/integration tests and app shell. Identify gaps in Phase 1 and reuse existing foundations. Don't gratuitously redesign things that already work.
- Implement Phase 1 improvements, as a cohesive working vertical slice, not just CSS screenshots. Write focused regression tests for chat navigation and responsive states. Keep conversation continuity from Vault/real service.
- Where the full Phase 1 scope is already done, demonstrate it from existing code/tests and focus on the concrete biggest remaining gaps.
- Run focused tests, full relevant typechecks, and build if feasible. CI may have baseline lint errors; distinguish pre-existing errors from regressions.
- Commit scoped verified code on feature/chat-evolution-8-phases. Provide a final concise report with exact changed files, commit(s), passing/failing tests, phase status, and precise next steps for Phase 2.
- Do NOT interact with the existing user's production Electron instance; if live testing is safe, use an isolated app/profile and don't leave it running.

## Phase 3 design and implementation plan

Execution remains inline in this worktree under the user's implement-now instruction.
Reusing the compiler and tool loop keeps Guard, grants, cancellation, provider selection,
encrypted conversation storage and the browser service authoritative. A separate research
store would duplicate that state; relying only on model prose would leave source identity
and negation unresolved. The chosen approach adds small pure helpers to those existing seams.

- [x] Intent: add failing cases in `chatIntent.test.ts` and `tool-intent.test.ts` for
  negated search/browser/deep-research requests, including composer-hint precedence.
  Implement bounded explicit refusal detection in `core/research/chat-intent.ts` and
  turn-only restrictions in the existing loop. Tests must show no tool body executed
  when a scripted provider asks for an explicitly forbidden search.
- [x] Citation identity: reproduce two searches returning different rank-1 URLs in
  `tool-loop.test.ts`. Add a per-turn source ledger used before observation rendering;
  both provider reports and persisted sources must agree on unique ranks, and repeated
  URLs must retain their assigned rank. No authority or output budget changes.
- [x] Follow-up context: add compiler and Mind regressions for “summarise source 2”,
  missing/ambiguous references, unrelated conversation scope, and tight budgets.
  `core/mind/research-context.ts` will resolve only the preceding assistant's typed
  sources. Its bounded JSON data enters as user-role reference material, never system
  instructions, and is counted inside the existing compiler budget. The current owner
  message stays verbatim. A source-only follow-up can cite retained evidence without
  inventing a new execution record or fetching a replacement result.
- [x] Source UI: reuse `AssistantMessageView` and the browser action seam. Add domains,
  snippets and retrieval times to actual typed sources, with useful empty/failure text
  driven by tool records. Add renderer regressions, preserving inactive links when
  the browser seam is absent.
- [x] Verify the full relevant regression suite, all TypeScript projects, scoped lint,
  diff checks and both builds. Run a real search and source follow-up in the approved
  visible feature profile on 9235, verify Core records and restart continuity, then
  close the test instance. Record any external/provider limitation honestly, review
  inline, and commit only verified Phase 3 changes.

### Phase 3 evidence and limits

Final focused validation: 69 files / 835 tests pass across Chat, research, tool-loop,
native Vault, reference compilation, context adversarial checks and cancellation.
The separate broader `tests/core/mind.test.ts` result is recorded below and is not
included in that all-passing count. All three TypeScript projects, scoped ESLint,
diff checks and renderer/desktop builds pass. The isolated feature instance is closed
after acceptance; the original checkout and instance were not operated.

The guarded real search returned five typed sources. A follow-up summarised source 2
from its stored snippet with the correct citation, domain and original retrieval time.
Neither that follow-up nor a subsequent explicitly declined lookup executed a tool.
A full feature restart preserved the selected conversation, all message identities,
source records and actual execution records in encrypted Vault storage. Evidence is
`artifacts/live-visible/chat-evolution/phase3.json` and `chat-research-follow-up.png`.
The acceptance script polls Core's actual matching turn and terminal outcome, supports
`--continue` without replacing completed turns, and `--restored` without provider calls.
It never automates an external website or inserts evidence into the application.

Typed reference resolution binds only the preceding assistant answer in the same
conversation. It supports numbered/ordinal source references and source-shaped plural
follow-ups, carries at most five sources under a 4,800-character reference ceiling,
and counts the whole block in the unchanged 3,000-token compiler budget. Missing,
ambiguous and oversized references are disclosed; new lookups cannot substitute for
an unresolved reference unless the owner explicitly requests a new lookup or selects
a composer tool. Plain code/pronoun follow-ups retain ordinary conversation behavior.
Source snippets are external reference data, not a claim that a full page was read or
that its statements were verified. Browser source buttons still use the existing seam;
full guarded browser-action acceptance remains part of the later integration phase.

Regression coverage includes multi-lookup rank collisions, duplicate URLs, high stored
ranks, refreshed same-URL snippets, hostile quoted text, scope isolation, context budget,
missing-reference replacement attempts, and success followed by failed retrieval.
Stored footers no longer disclaim an earlier successful result when a later lookup fails.
Legacy duplicate ranks remain literal inline markers instead of silently choosing a URL.
Empty, failed and blocked searches have distinct renderer notices from typed records.

The separate broader Mind suite passes 38 of 40 tests and has two remaining previously recorded failures: the stale
one-call grant expectation and concurrent recalled-context metadata. The formerly failing
fresh-weather test now passes because an absent requested search tool refuses before
provider contact. An older red-team activity-shape assertion was updated to admit Phase
1's opaque conversation/turn IDs while retaining its closed metadata shape and private-text
checks. SQLCipher wrong-key diagnostics are expected negative-test output; existing
renderer externalization and large-chunk warnings remain. No permission, grant, tool-call,
output-token, or global context budget was widened. Next: Phase 4 universal right workspace.

## Exact changed-file inventory

Phase 1 (295b436):

- `FreyaChatDebug.cmd`
- `core/conversation/service.ts`
- `core/events/envelope.ts`
- `core/events/validate.ts`
- `core/index.ts`
- `core/mind/mind.ts`
- `core/protocol/activity.ts`
- `core/protocol/conversation.ts`
- `core/protocol/core-protocol.ts`
- `docs/chat-evolution-8-phases.md`
- `electron/preload.ts`
- `scripts/chat-shell-acceptance.mjs`
- `src/app/App.tsx`
- `src/app/chat/ChatHistory.tsx`
- `src/app/chat/ChatSidebarResize.tsx`
- `src/app/chat/Chats.tsx`
- `src/app/entry.tsx`
- `src/app/screens/HomeDashboard.tsx`
- `src/app/screens/home-dashboard.css`
- `src/platform/conversationClient.ts`
- `startup.md`
- `tests/core/chat-session-semantics.test.ts`
- `tests/unit/app/chatAvailability.test.tsx`
- `tests/unit/app/chatFailures.test.tsx`
- `tests/unit/app/chatHistory.test.tsx`
- `tests/unit/app/chatSidebarResize.test.tsx`
- `tests/unit/app/conversationConnection.test.ts`

Phase 2 (ec85393):

- `core/conversation/artifacts.ts`
- `core/mind/tools.ts`
- `core/protocol/conversation.ts`
- `core/vault/repositories/conversation-store.ts`
- `core/vault/schema.ts`
- `docs/chat-evolution-8-phases.md`
- `scripts/chat-rendering-acceptance.mjs`
- `src/app/chat/AssistantMessageView.tsx`
- `src/app/chat/assistantParts.ts`
- `src/app/chat/chat.css`
- `src/app/chat/Chats.tsx`
- `src/app/chat/clipboard.ts`
- `src/app/chat/RichMessage.tsx`
- `tests/core/mind/chart-tool.test.ts`
- `tests/core/vault/vault-conversation-sql.test.ts`
- `tests/unit/app/assistantMessageView.test.tsx`
- `tests/unit/app/chatRendering.test.tsx`
- `tests/unit/app/richMessage.test.tsx`

Phase 3 (scoped research commit):

- `core/mind/context-compiler.ts`
- `core/mind/loop.ts`
- `core/mind/mind.ts`
- `core/mind/research-context.ts`
- `core/mind/source-ledger.ts`
- `core/mind/tool-intent.ts`
- `core/mind/tools.ts`
- `core/research/chat-intent.ts`
- `docs/chat-evolution-8-phases.md`
- `scripts/chat-research-acceptance.mjs`
- `src/app/chat/AssistantMessageView.tsx`
- `src/app/chat/chat.css`
- `tests/core/context-redteam/context-redteam.test.ts`
- `tests/core/mind/research-context.test.ts`
- `tests/core/mind/tool-intent.test.ts`
- `tests/core/mind/tool-loop.test.ts`
- `tests/unit/app/assistantMessageView.test.tsx`
- `tests/unit/chatIntent.test.ts`
