# Freya Chat Evolution — 8 Phases: implementation brief

## Phase progress (2026-10-09)

| Phase | Status | Tests | Commit |
|---|---|---|---|
| 1. Chat Shell | Complete | 372 focused tests; full TypeScript; scoped lint; renderer/desktop build; live provider and restart checks | `feat(chat): complete shell navigation and durable selection` |
| 2. Rendering | Not started | — | — |
| 3. Research | Not started | — | — |
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
