# Freya UI unification implementation plan

**Navigation revision:** The owner subsequently requested a separate primary Mind page, vertical subpages and a sidebar redesign. The seven-page hierarchy and remaining work are defined in `docs/superpowers/specs/2026-10-10-navigation-revision-design.md` and `docs/superpowers/plans/2026-10-10-navigation-revision.md`. The original six-page requirements below are historical and superseded.

**Goal:** One coherent default app with exactly Home, Chats, Missions, Library, Office, and Settings in the primary navigation.

**Architecture:** Keep `src/main.tsx -> src/app/entry.tsx -> src/app/App.tsx -> src/app/screens/HomeDashboard.tsx` as the shipping shell. Resolve existing internal route names to canonical nested routes, retain mount-once workspace layers, and consume existing read-only Core projections. UI visibility never starts, stops, or authorizes a Core engine.

**Stack:** React 19, TypeScript, existing glass CSS and shared primitives, Electron IPC mirrors, Vitest and Testing Library.

**Execution boundary:** The owner subsequently approved the UI rebuild with a commit for each step. Work directly on `feat/mind-phase8-live-integration` in `C:\Users\you\Desktop\AI\Freya`. Follow the approved UI design in `docs/superpowers/specs/2026-10-10-ui-unification-design.md`: complete the six-destination shell, projected Office room and removal of alternate shipping UI. No worktree, checkout, new desktop directory, push or new Electron instance. Stop on unexpected concurrent edits. Do not modify secrets, user data, Core policies, or Freya-main. Backend association migrations and intelligence evaluation remain separate roadmap work.

## Phase 0: source inventory and migration map

Baseline: `736c0b0` (`feat(chat): persistent workspace icon rail and instant composer clearing`). Working tree clean before edits; no repository or ancestor AGENTS.md was found.

| Source | Current responsibility | Migration decision |
| --- | --- | --- |
| `src/main.tsx` | Default app entry; `?ui=v2` alternate entry | Keep default app; defer alternate entry removal to Phase 5 |
| `src/app/entry.tsx` | Adapter selection, styles, preferences, layout, conversation restoration | Default app always reads the live adapter; no preview fixture fallback |
| `src/app/App.tsx` | Screen state, browser split, real chat send/stop, voice | Canonicalize route navigation; remove imports of sample route builders |
| `src/app/screens/HomeDashboard.tsx` | Live left navigation, Home board, persisted layers, composer | Six primary destinations; keep Home geometry and existing chat/browser plumbing |
| `src/app/screens/HomeWidgets.tsx` | Home side cards and shortcuts | Route to new workspaces; weather reports not connected |
| `src/app/presence/StargateHub.tsx` | Fixed Home orb, component artwork and shortcuts | Preserve geometry, animation and component IDs; route shortcuts into new hierarchy |
| `src/app/screens/Mind.tsx` | Read-only Mind inspection from live snapshot | Reuse under Library / Mind; no engine lifecycle tied to this screen |
| `src/app/screens/Settings.tsx` | Real provider, voice, privacy, stop-all, diagnostics | Preserve controls; Advanced collapsed initially, Security nested there; spending reports only actual usage |
| `src/app/chat/*` | Chat history, media/video, browser split, eight-icon right rail, instant composer | Retain; regression-test without starting Electron |
| `src/app/screens/{Focus,Memory,People,World,Life,Workforce,Foundry,Relay}.tsx` | Sample slot builders | Remove from live route graph; retain files until dependency cleanup in Phase 5 |
| `src/ui/shell/Navigation.tsx` | Old navigation | Not the live navigation; do not edit it to implement this milestone |
| `src/ui-v2/entry.tsx`, `src/ui-v2/App.tsx` | Alternate standalone app | Removal deferred until shared dependency extraction |
| `src/ui-v2/{state,theme,primitives,chat,assets}` | Live adapter/contracts, preferences/tokens, Glyph/Clock, sendMessage, artwork | Still consumed by default app: retain all until safely extracted |
| `src/platform/{core,mission,work,workforce,conversation,attention,brain,consciousness,world,personality,context,self,office}Client.ts` | Existing typed read/command boundaries | Reuse reads already in the snapshot in Phase 1; deeper wiring in later phases |
| `core/longhorizon/{engine,store,types}.ts`, `core/vault/repositories/goal-store.ts` | GoalEngine, GoalStore, encrypted goal persistence | Preserve; long-horizon Goal remains distinct from Mission |
| `core/missions/*`, `core/work/*`, `core/protocol/longhorizon.ts` | MissionEngine, WorkEngine, bounded execution, read-only goal vocabulary | Preserve contracts and domain semantics; no schema rewrite in Phase 1 |
| `core/office/*`, `core/proactive/*`, `core/attention/*`, `core/longhorizon/*` | Real Office projection and authorized continuous work | Visualization only; Core keeps runtime authority |

Shared dependencies also reach `src/app/cards`, presence/dressing/chat components, and the platform layer. Removing `src/ui-v2` now would break the shipping app's state, CSS, glyphs, artwork, and chat commands. Phase 5 must inspect imports across `src`, tests, scripts, Electron build entries and lazy imports before deletion.

### Exact current-to-new route map

Routes are internal workspace keys, not web URLs. Cold start remains `home`; a nested path persists in the existing `AppLayout.nav` string. Unknown paths safely resolve to `home`.

| Current route / shortcut | Canonical route | Primary selection |
| --- | --- | --- |
| `home` | `home` | Home |
| `chat`, `chats` | `chat` | Chats |
| `missions`, Home mission / review shortcuts | `missions/missions` | Missions |
| `goals` | `missions/goals` | Missions |
| `runs`, `work` | `missions/runs` | Missions |
| Mission chats / files / heartbeat | `missions/chats`, `missions/files`, `missions/heartbeat` | Missions |
| `library`, `mind` | `library/mind` | Library |
| `focus` | `library/mind/focus` | Library |
| `memory`, Home recent results / activity | `library/mind/memory` | Library |
| `people` | `library/people` | Library |
| `world` | `library/world` | Library |
| `files`, `search` | `library/files`, `library/search` | Library |
| `life` | `library/mind/memory` | Library |
| `office`, `workforce`, Home team shortcut | `office/agents` | Office |
| Office scene | `office/scene` | Office |
| `settings` | `settings/appearance` | Settings |
| Provider / voice / privacy / spending / about | `settings/provider`, `settings/voice`, `settings/privacy`, `settings/spending`, `settings/about` | Settings |
| `create`, `foundry` | `settings/advanced/foundry` | Settings |
| `relay` | `settings/advanced/relay` | Settings |
| `harness`, `context`, `security`, `diagnostics` | `settings/advanced/harness`, `settings/advanced/context`, `settings/advanced/security`, `settings/advanced/diagnostics` | Settings |

### Phase 0 acceptance

- [x] Verify branch and clean tree; locate shipping entry and actual navigation.
- [x] Inventory route builders, shared dependencies, projections and protected domains.
- [x] Record exact route migration and the future relationship migration boundary.

## Phase 1: six primary destinations and honest route frames

Implementation files: `src/app/state/routes.ts`, `src/app/screens/{WorkspaceFrame,UnifiedWorkspaces}.tsx`, `src/app/screens/unified-workspaces.css`; updates to App, HomeDashboard, HomeWidgets, StargateHub, entry and Settings. UI tests: `tests/unit/app/uiUnification.test.tsx`.

- [ ] Write failing UI tests for six primary destinations, nested navigation, legacy shortcuts, live resource gates, Settings Advanced, and persistent chat state.
- [ ] Run targeted Vitest and verify expected failures before implementation.
- [ ] Add canonical route resolver and accessible workspace frames with keyboard-operable contextual tabs (Arrow keys, Home, End), selected tabs and labelled panels.
- [ ] Missions: Goals, Missions, Runs, Chats, Files, Heartbeat in one workspace. Use live Mission summaries and active Run threads, show read freshness and projection bounds; all unbridged associations explicitly not connected. No creation, approvals, execution or heartbeat activation in this phase.
- [ ] Library: Mind, People, World, Files, Search; Focus and Memory nested within Mind. Reuse Mind inspection, live attention, world summary and memory summary where available. Knowledge records, relationship records, file catalogue and global search remain explicitly not connected.
- [ ] Office: Agents and Office scene. Real workers from the existing snapshot; honest empty/unavailable/stale states. Adult Freya / 3D scene deferred to Phase 4.
- [ ] Settings: retain real model/provider, voice, permission/privacy and stop-all controls; add usage-only Spending; put Foundry, Relay, Harness, Context, Security, Diagnostics in collapsed Advanced. Existing Core engines remain intact.
- [ ] Preserve fixed Home orb, Chibi, four-card columns, collapsible navigation, CSS, media/video, browser split, eight-icon permanent chat rail, Browser enablement gate and instant Send/Enter clearing. Remove static weather/build claims and default-app preview fixture selection.
- [ ] Run `npm run typecheck`, targeted Vitest including existing app/chat/browser regressions, `npm run lint`, `npm run build`; do not invoke acceptance scripts that launch Electron.
- [ ] Review diff and check for unexpected edits; stage only explicit session files and commit on the existing branch if checks pass.

## Phase 2: Missions and verified work (not executed here)

Wire existing Goal, Mission, Work, conversation, approval and file contracts to the Missions workspace. Goal is a long-horizon entity with its own encrypted GoalStore; Mission is a bounded entity owning Runs, Evidence, Files and optional heartbeat, and may associate with multiple chats. Preserve identifiers and existing encrypted stores. Do not convert Goals into Missions or delete GoalEngine.

Before changing persistence, inventory existing goal/checkpoint/mission/run and conversation mission references. Specify additive, versioned association records with source IDs, provenance, reversible migration, deduplication and orphan handling. Keep existing readers working and test restarts, deletion boundaries and multiple-chat links. Display only verifier-established results; completion requests never assert success. Use existing approval gates and owner actions. Heartbeat requires explicit opt-in, approval, spending limits and durable stop/recovery semantics before enabling it.

## Phase 3: Library and knowledge (not executed here)

Use existing Brain, World, relationship, context and file APIs for authorized records, global search and provenance. Mind contains Focus and Memory inspection and remains continuously available in Core when authorized, regardless of whether its UI is visible or the window is open. People and World expose only authorized projected records. Unify documents and generated artifacts in a provenance-bearing catalogue with links back to chats, Missions and Runs. Vault secrets are never public files, searchable documents or artifacts. Test withholding, stale projections, source traceability, record lifecycle and file access refusal.

## Phase 4: real 3D Office (not executed here)

Reuse `core/office` and `src/platform/officeClient.ts` to render active workstations from actual agent state. Adult Freya inhabits the Office; Chibi represents Freya on Home. Scene movement and UI visibility do not schedule work, change authority or drive runtime. Empty office means no projected agents; unavailable means the source could not report. Test lifecycle updates, blocked/idle workstations, stale projection handling and teardown without stopping Core.

## Phase 5: Settings and safe legacy removal (not executed here)

Finish real model, voice, permissions, spending and Advanced surfaces for Foundry, Relay, Harness, Context, Security and diagnostics. Extract shared contracts/live adapter, preferences/theme, primitives, sendMessage and referenced assets into neutral modules before removing old `src/ui` and standalone `src/ui-v2` app. Migrate consumers/tests/build entries, prove parity, then remove alternate entry and dead screens. Keep Core domains, security policies and private data intact. Require typecheck, lint, regression tests and renderer/main builds at each extraction boundary.

## Phase 6: real Electron acceptance (not executed here)

With owner authorization for the live runtime, validate the single shipping app against actual Core and existing data: startup/Home, all six destinations, Goals versus Missions, multiple chats per Mission, Runs/evidence, approval refusal and acceptance, provenance/files, Library search, continuously authorized Mind, real agent Office, Settings/spending and opt-in heartbeat limits. Exercise media/video preview, instant Send and Enter clearing, eight-icon rail, Browser disabled until enabled, chat/browser split, window closing/relaunch, stop-all and recovery. Record actual commands and observed results; no fixtures or simulated success qualify as live acceptance.

## Verification record

Step 0: `be585d3` records the approved design and source inventory.

Step 1: `2bc27e2` implements the six-destination shipping shell, canonical routes, accessible section tabs, real read-only summaries, remembered sections and retained chat state. All 27 UI unification tests pass after review fixes. The 36 existing app test files passed (252 tests); review added two memory-source and return-navigation regressions, verified separately. Type checks and renderer/Electron builds pass; lint passes on changed TypeScript files. Repository-wide lint has 424 pre-existing errors in untouched tooling and legacy files, recorded in `.kilo/ui-lint.log`.

Step 2: Office now renders the existing OfficeProjection in a CSS 3D room, including Freya's portrait, workers, live runs and approvals. Camera controls, a flat view and an accessible station directory change only presentation. Real Office presence (including locked versus ready lifecycle), unavailable state, selection updates, projection limits and camera behavior have five passing regression tests. The combined Office/navigation suite passes all 32 tests. Type checks, lint on changed files and renderer/Electron builds pass.

Layout QA uses explicitly labelled fixture stations, not a live Core: a 27-station maximum-capacity room has no overlapping flat-view station footprints and no clipped perspective labels at 1440px. Perspective and flat screenshots are saved in `.kilo/office-layout-qa.png` and `.kilo/office-layout-flat-qa.png`. Worker-zone presentation is compressed because Core's existing virtual worker and run grids overlap; Core coordinates and state are unchanged. The room has no continuous animation or WebGL dependency and respects reduced motion.

Vitest's default fork pool fails to read temporary transformed modules on this Windows sandbox. `--pool=threads --maxWorkers=2` runs the same isolated suites successfully; no assertion or production behavior is changed to accommodate the runner.

Mission associations, knowledge contents, global files/search and specialist controls without a UI bridge remain explicitly not connected. Goals remain a real, separate Core entity. No execution, approvals or heartbeat activation is added by this UI step. Live Electron acceptance has not been performed.
