# Freya Master Plan

**Status:** canonical development plan  
**Owner:** personal Freya first  
**Canonical from:** 2026-10-03  
**Current trusted baseline before this plan:** `main@d4b4948` (through Phase 18 integration)

This file is the single source of truth for Freya's product architecture, roadmap, execution order and development rules.
If an architectural direction changes, **PLAN.md changes first**. Chat discussions, temporary prompts and branch notes do not silently supersede it.

## 1. Product destination

Freya is one persistent personal intelligence, not a chatbot, model, dashboard, avatar, or collection of agents.
Models are replaceable reasoning engines. Freya is the durable Core: identity, continuity, judgment, memory, context, work, relationship, authority and learning.

The first target is **Aslam's personal local-first Freya** on one Windows machine.
Boundaries must remain clean enough that a later commercial version does not require rewriting Core.
The long-term threshold is a Jarvis-like system that can pursue multi-week goals, use bounded digital tools, remember, delegate, verify, learn, recover and continue.

The primary long-term practical objective is **economic self-sufficiency**: Freya should eventually create and operate useful revenue-producing work while remaining inside owner-defined authority, spend and legal boundaries.

## 2. Immutable principles

1. Core owns truth and authority; renderers only display projections and submit bounded requests.
2. Models reason; code controls; events remember; verification establishes outcomes.
3. Knowledge is not permission. A claim, skill, model output or worker statement cannot mint authority.
4. STOP ALL, Guard, privacy, owner approval and immutable safety boundaries outrank convenience and autonomy.
5. No plaintext fallback for protected durable state.
6. Idle Freya makes no paid model call and performs no hidden background reasoning.
7. Missing, stale, conflicted and unknown information remain explicit; the UI never fills gaps with plausible fiction.
8. Every consequential external effect is attributable, bounded, inspectable and recoverable where possible.
9. Agents are subordinate workforce, not independent sovereign intelligences.
10. Generated capability starts untrusted and inactive.
11. Self-improvement cannot silently modify trusted runtime code or widen Freya's authority.
12. Durable cognitive data is private to Core; renderers never receive database handles, encryption keys or unrestricted raw stores.
13. Large media and large files do not live inside the structured database.
14. Context is permissioned and provenance-carrying, never an excuse for global surveillance.
15. Conversation is not automatically memory; admission remains explicit/code-owned.
16. Owner-visible inspect, export, correct and withdraw/forget semantics are required for durable cognitive data.
17. The current development workflow is conservative by design: isolated worktree, one owner model, independent audit, full gate, then merge.
18. During the current development cycle, implementation/review models are **Space Bunny Go** and **LongCat Go** only.

## 3. System shape

```
                          FREYA CORE
 identity · self · personality · relationship · memory · world · life
 context · missions · work · experience · skills · workforce · attention
              guard · governor · cognition · events · relay
                               |
                         Freya Protocol
                               |
          +--------------------+--------------------+
          |                    |                    |
     Adult Presence        Chibi Presence        App Mode
 autonomous/immersive      collaborative         deep workspace
          |                    |                    |
          +--------------------+--------------------+
                               |
                         Capability Broker
                               |
          browser · terminal · clipboard · download/upload
```

Adult and Chibi are the **same Freya identity**.
Adult Presence is used when Freya is doing work in the immersive experience.
Chibi Presence is the small-footprint co-working form when the user and Freya are working together around normal windows.
Brain/Core visualization is separate cognition telemetry; it is not Adult Freya's face/body.
## 4. Canonical persistence: one encrypted Freya Vault

Freya will use **one per-user SQLCipher database** as the canonical structured durable store.

Canonical logical location:
`<OS user-data>/Freya/vault/freya.db`

On Windows this resolves under the signed-in user's own `C:\Users\<user>\AppData\...` application-data area.
The repository never owns the live Vault.

Rules:
- One SQLCipher database, many logical schemas/tables.
- Actual SQLCipher encryption must be proven at runtime; plain SQLite with application-level field encryption is not an acceptable substitute.
- One random 256-bit Vault key, protected by the OS keyring/DPAPI on Windows.
- The key never appears in source, environment projections, renderer state, logs, prompts, journal events, backups or the database itself.
- No plaintext fallback when keyring or database open fails.
- Database schema changes are versioned and transactional.
- Backups remain encrypted.
- Large media/files stay outside the DB. The DB stores metadata, hashes and protected references only.
- Future large-object storage, if needed, lives behind a separate protected object/file boundary.
- Credentials, API secrets and connector tokens remain in the OS-backed secrets/keyring layer rather than ordinary cognitive tables.
- Search/FTS/vector indexes are derived and rebuildable; they are not canonical truth.

Before schema implementation, the Vault foundation branch selects **one SQLCipher-capable binding** that passes Windows + Electron + test-runtime build/restart/encryption checks. Once selected, it is canonical; changing it later requires a PLAN.md decision.
### 4.1 What moves into SQLCipher

All structured durable application/domain state moves to the one Vault:
- Brain admitted memory/knowledge metadata and durable cognitive records
- conversations and turns
- Context durable records
- Missions
- Work/task/run durable records where not event-only
- Workforce durable records/claims
- Personality and Relationship state
- Attention schedules/durable state
- Foundry metadata
- Relay metadata and durable approval/idempotency state
- Skills
- Life History
- Self Model
- World Model
- Experience
- app/user settings and other structured persistent product state where practical

The current custom encrypted domain stores are transitional implementation history, not the mature architecture.

### 4.2 What does NOT move into the Vault

The Core security/event fabric remains a separate append-only metadata journal behind `EventStore`.
Its purpose is audit/replay, not relational querying.
It must remain free of secrets/private bodies and preserve deterministic sequence/recovery behavior.

Secrets/key material remain outside both the event journal and normal SQL tables.

### 4.3 Migration policy now

This is a **developer/system migration now**, not a Freya autonomous action.
There is no important production user data yet, so we do not maintain a permanent dual-format or complicated legacy runtime migration path.
The storage correction branch moves code/tests to SQLCipher, verifies the result, retires old write paths and treats old prototype files as disposable.
Future product schema migrations are system-owned, transactional and versioned; models/Freya never invent or execute migrations autonomously.
## 5. Cognitive/domain ownership

These logical domains share one encrypted database but keep separate authority and APIs.

**Brain** — admitted semantic/personal memory and durable knowledge. Brain is evidence/knowledge, not authority.  
**Self** — Freya's durable descriptive model of herself: identity descriptors, current role, known limitations, goals and capability references. Code-owned Constitution/Guard remain above it.  
**World** — evidenced entities, facts, relations and changing external state with provenance, freshness and conflict.  
**Life** — autobiographical episodes, milestones, periods, themes, revision lineage, withdrawal and continuity.  
**Personality / Relationship** — stable temperament, preferences, interpersonal posture, familiarity, habits and expression history.  
**Context** — temporary scoped working context with provenance, TTL and revocation.  
**Experience** — what happened when Freya attempted work: observations, verification, outcome, correction and performance evidence.  
**Skills** — reusable procedures learned/evaluated from evidence; skill state never grants authority.  
**Conversation** — transcript/session continuity; conversation text is not automatically admitted memory.  
**Missions** — persistent outcomes.  
**Work** — execution: Run -> Step -> Action -> Observation -> Verification.  
**Workforce** — subordinate agents/teams and attributable bounded delegation.  
**Attention** — event intake, heartbeat policy, cue/interruption decisions.  
**Foundry** — artifacts, tools, modules and applications under verification/promotion.  
**Relay** — bounded connector transport/control plane.

World owns factual relationships. Personality/Relationship owns interpersonal posture and social continuity.
Life answers "what happened in Freya's life"; Experience answers "what did Freya try, what happened, and what should be learned from it?"

## 6. Unified Conscious Context

Phase 20 is a **pure, read-only derived projection**, never a durable database or second source of truth.
It consumes authoritative projections from Self, World, Life, Brain, Personality, Context, Missions, Work, Workforce, Attention and related domains.
Its job is to answer: what is Freya focused on, what matters, what is waiting, what changed, what is uncertain and what is next.
## 7. Autonomy, events and heartbeat

Freya does not continuously poll or continuously think.

Allowed wake sources:
- explicitly authorized events
- explicit schedules
- a bounded scheduled heartbeat
- direct owner interaction
- active Mission/Work transitions already authorized by Core

A heartbeat is deterministic/lightweight first. Waking does **not** automatically mean calling a model.
Attention/code decides whether cognition is justified.

For self-improvement:
- no-cost deterministic maintenance may occur only inside the development/staging boundary and must still obey policy;
- if an improvement would consume model/API tokens or other spend, Freya asks the owner before starting unless a future PLAN.md change establishes an explicit pre-approved improvement budget;
- any change to trusted runtime code requires owner approval before merge regardless of cost.

Consequential external effects continue to require their existing capability/approval path.
No hidden always-on autonomous reasoning loop is permitted.

## 8. Digital Hands: initial allowed scope

The current target Hands scope is deliberately narrower than the old broad computer-control concept:
- browser control through a managed/bounded browser capability
- controlled terminal
- clipboard
- downloads
- uploads

Explicitly **not granted yet**:
- screenshots or global screen capture
- unrestricted mouse/keyboard computer control
- unrestricted app control
- unrestricted filesystem/editor authority

The Vault directory, keyring/secrets paths and protected backups are hard-denied to Browser/Terminal/Hands even when broader machine access is added later.
We test the narrow set first. More device authority requires an explicit PLAN.md update after real alpha testing.
## 9. Model strategy

Runtime cognition stays provider-independent behind the single Model Gateway.

Current runtime priority:
1. **NanoGPT** — primary runtime provider.
2. **OpenCode API** — secondary/fallback provider.

Models may be routed by task/cost/quality only within owner-approved providers, models and budgets.
No model can bypass Governor, Guard, context compilation, cancellation or STOP ALL.
Local/offline models are optional later for sovereignty/resilience; they are not required for the current build.

Current development workflow models:
- Space Bunny Go
- LongCat Go

Office/company-provided model accounts are not part of the trusted Freya development/runtime path.

## 10. Self-improvement architecture

Freya never rewrites her trusted runtime in place.

Improvement flow:
```
observe evidence -> propose improvement -> owner approval when required
-> separate freya-dev/freya-staging or per-change branch
-> implement -> tests -> red team -> benchmark/verification
-> review/rollback check -> owner approval -> merge to trusted main
```

Constitution, Guard, key protection and immutable authority ceilings are not self-editable targets.
Generated code/tools/skills/modules begin untrusted and inactive.
## 11. Economic intelligence and enterprise

Phase 32 begins with:
- market/business research
- evidence gathering
- backtests/simulations where legitimate
- paper trading and similar zero-real-capital experiments
- measurable result tracking

No real-money trading/spending is authorized by this plan.
If paper/simulated work demonstrates useful results, any transition to real capital requires a later explicit owner decision and PLAN.md update.

Phase 33 target is an owner-controlled autonomous business/project environment, currently named **Webzone**.
Freya should eventually be able to identify opportunities, research, build products/assets, operate the website, delegate work, track metrics and handle approved communications.
Contracts, legal commitments, account creation, real spending, financial transfers and other binding actions remain owner-gated unless a future explicit policy says otherwise.

The business goal is not "make money at any cost"; it is verified, sustainable economic self-sufficiency under owner control.

## 12. Privacy and owner control

Every durable cognitive domain must support an appropriate path for:
- inspect
- export
- correct/revise
- withdraw/forget

Withdrawal propagates to derived indexes/projections and must not silently reappear after restart.
Conflicts remain represented rather than rewritten into certainty.
Broad projections contain bounded metadata/summaries, not unrestricted private bodies.
## 13. Roadmap status: Phase 0-18

| Phase | Scope | Status |
|---|---|---|
| 0 | Desktop shell / honest local workspace foundation | completed |
| 1 | Core authority, Guard, Governor, cognition, budgets, STOP ALL, event fabric | completed |
| 2 | Command Center foundation | completed |
| 3 | Mind, real conversation and local voice foundation | completed |
| 4 | Brain: identity, admitted memory and continuity | completed |
| 5 | Research: search, managed browser and cited evidence | completed |
| 6 | Work execution engine | completed |
| 7 | Missions: persistent verified outcomes | completed |
| 8 | Workforce: bounded subordinate agents | completed |
| 9 | Context Awareness + encrypted restart recovery | completed |
| 10 | Harness and Computer Hands foundation | completed, authority remains intentionally bounded |
| 11 | Personality and Relationship | completed |
| 12 | Events and Attention | completed |
| 13 | Desktop Presence | completed |
| 14 | Office projection | completed |
| 15 | Foundry | completed |
| 16 | Relay | completed |
| 17 | Skills, evaluation and controlled improvement | completed and merged |
| 18 | Integration, security and packaging hardening | integrated; final installer signing/update-channel closure remains deferred |

The trusted baseline before Phase 19 integration is `d4b4948`.

## 14. Roadmap: Phase 19-29

| Phase | Scope | Required outcome |
|---|---|---|
| 19 | UI / Presence / App Mode / visual system | final Adult/Chibi/App experience, truthful workspaces, modular windows; merge final design then wire real Core |
| 20 | Unified Conscious Context | one bounded read-only current-context projection; no new truth/store |
| 21 | Deep Memory & Life History | durable autobiographical continuity on canonical SQLCipher persistence |
| 22 | Self & World Model II | durable evidenced Self/World graph on canonical SQLCipher persistence |
| 23 | Continuous Life Loop | event/heartbeat wake -> understand -> decide -> bounded act -> verify -> continue |
| 24 | Executive Intelligence | prioritization, planning, coordination and uncertainty handling over real missions/work |
| 25 | Digital Senses & Hands II | tested browser/terminal/clipboard/download/upload capability expansion only |
| 26 | Natural Presence | richer natural voice/presence/embodiment without inventing internal state |
| 27 | Relationship Intelligence II | deeper long-term relationship understanding with provenance and anti-dependence safeguards |
| 28 | Experience -> Knowledge -> Skill | verified outcomes become structured experience, knowledge and reusable procedures |
| 29 | Autonomous Capability Acquisition | detect capability gap -> propose/build -> verify -> gated activation |
## 15. Roadmap: Phase 30-39

| Phase | Scope | Required outcome |
|---|---|---|
| 30 | Self-Improving Architecture | staging-branch improvement loop with tests, review, rollback and owner-controlled merge |
| 31 | Long-Horizon Autonomy | safely continue multi-day/multi-week goals across restarts/events without hidden continuous spend |
| 32 | Economic Intelligence | research, simulation/paper experiments and measured economic evidence |
| 33 | Autonomous Enterprise | operate Webzone within approved communication/financial/legal boundaries |
| 34 | Multi-Device Freya | **deferred**; one-device Freya remains canonical until this is revisited |
| 35 | Physical World Interface | **deferred/undefined**; no physical-world authority is added until owner explicitly designs this phase |
| 36 | Resilience & Self-Recovery | crash/data/provider failure recovery, backup restore, degraded-mode honesty and repair workflows |
| 37 | Sovereign Intelligence | provider independence, optional offline/local reasoning path, portable encrypted identity/data |
| 38 | Cognitive Evolution | evidence-driven improvement of planning/reasoning/learning without authority drift |
| 39 | Mature Freya / Jarvis Threshold | coherent persistent executive intelligence able to pursue long goals and become economically self-sufficient under owner control |

Cloud/hosted Core is deferred.
Commercial packaging remains a later concern after the personal Freya proves itself.
Multi-device and physical-world work must not leak requirements backward into current implementation unless a boundary would otherwise become impossible to change.

## 16. Mature Freya acceptance target

At Phase 39 the owner can give Freya a multi-week goal in natural language and Freya can:
- understand relevant authorized context and the world around the goal;
- remember relevant history and relationship context;
- plan, create Missions/Work and delegate to bounded workforce;
- use approved digital hands;
- request approval only when authority, cost or uncertainty genuinely requires it;
- verify outcomes rather than equating action with success;
- learn from Experience and improve Skills;
- survive restarts/provider failure without losing identity or fabricating state;
- continue from events/heartbeats without continuously spending tokens;
- explain what she is doing, waiting for, unsure about and why;
- build and operate useful economic work toward self-sufficiency.
## 17. Immediate execution order from 2026-10-03

This order is mandatory until PLAN.md is deliberately changed.

### Step A — PLAN on main
Create, review, commit and push this PLAN.md directly on `main`.

### Step B — Phase 19 final integration
Phase 19 design is considered finished by the owner.
Deep-audit the actual final `phase-19-ui` tree, commit only real source/docs/tests/assets (not screenshot/temp garbage), and verify it.
Integrate the UI into the latest main **without reverting Phase 17/18 backend/security files**.
Phase 19's old Phase-16 base is not allowed to overwrite newer Core/platform/electron code.
Run full verification, then merge/tag/push.

### Step C — canonical SQLCipher Vault correction
Create a new isolated foundation branch from the Phase-19 main.
Select and lock one actual SQLCipher binding after a build/encryption spike.
Move all structured durable stores to one per-user `freya.db`.
Retire the bespoke custom-store write paths.
Keep EventStore journal separate.
No dual-write architecture and no model/Freya-controlled migration.
Run encryption, restart, wrong-key, crash-recovery, privacy, typecheck, lint, unit, red-team, E2E, build and release gates.
Merge only when green.

### Step D — adapt current Phase 21
Do not merge `26a48b7` as-is because its Life semantics are useful but its custom persistence is now obsolete.
Rebase/adapt Life onto the SQLCipher repository architecture, preserve provenance/revision/conflict/withdrawal semantics, re-audit and merge.
### Step E — adapt current Phase 22
Rebase/adapt Self & World Model II onto the new main and canonical SQLCipher storage.
No new custom durable store.
Audit identity spoofing, relationship forgery, stale/conflicting evidence, capability escalation and privacy before merge.

### Step F — finish/adapt Phase 20
Bring Unified Conscious Context onto the resulting main.
It must consume Phase 21 Life and Phase 22 Self/World projections rather than create durable copies.
It remains read-only/derived and merge last among 20/21/22.

### Step G — wire and explicitly test the real app
Wire the merged Phase-19 UI to the now-stable real Core projections/commands.
Home/Mind consume Phase 20; Life consumes Phase 21; World/Self consumes Phase 22; other workspaces consume their existing authoritative domains.
No fake live data.
Build the Electron alpha and perform the owner's explicit manual test before continuing to Phase 23.

Existing Phase 20/21/22 branch work is preserved as implementation material but must conform to this plan at integration.
The paused `alpha/ui-integration` branch is not canonical; it may be discarded or harvested selectively after Phase 19 final integration.

## 18. Current branch/worktree discipline

For the current development cycle:
1. one issue/phase or integration concern per isolated branch/worktree;
2. one owner model per working tree;
3. no concurrent models editing the same worktree;
4. owner implements and tests;
5. independent Space Bunny Go / LongCat Go review or red-team;
6. fixes occur before acceptance;
7. re-review security/authority/privacy seams;
8. run full verification/release-compatible gate;
9. merge in dependency order;
10. tag verified integration points.

Do not merge because an owner model says "done". Completion means independent verification.
## 19. Verification gates

Every architecture/security phase must prove, as applicable:
- typecheck
- lint
- focused unit/domain tests
- full test suite
- red-team/adversarial tests
- real Electron E2E/relaunch checks
- production build
- release budget/check
- release gate

Vault-specific gates additionally require:
- actual SQLCipher runtime/version proof;
- raw database bytes do not contain planted plaintext sentinels;
- wrong-key open fails safely;
- missing keyring fails closed with no plaintext database;
- restart/replay produces deterministic projections;
- transactional schema migration/rollback tests;
- backup/restore remains encrypted;
- renderer/Hands cannot open the DB or obtain the key;
- Vault/keyring paths are denied by digital Hands.

Phase 19 UI integration additionally requires:
- no preview/sample content in live mode;
- no fake percentages/progress/people/world/memory;
- no silent fallback from failed live Core to preview;
- accessibility/keyboard/window behavior checks;
- real STOP ALL/refusal/error states visible to the owner.

## 20. Release path

Current path:
developer build -> owner's explicit personal alpha -> runtime/UX/state bug fixing -> later private beta -> later signed installer/update channel -> later commercial hardening.

This release path is intentionally revisitable.
Phase 18's final installer signing/notarization/update-channel work remains deferred until external distribution matters.
## 21. Deferred connector/product expansion

After the local alpha and Hands/security boundaries are proven, planned connectors include:
- Gmail/email
- Calendar
- Drive/files
- GitHub
- Telegram
- WhatsApp

Prefer official/native APIs or well-bounded plugins/connectors; browser fallback is last resort.
Each read/write action remains a separate capability and writes preserve approval where required.

One device is canonical for now.
Cloud sync/hosted Core is deferred.
Physical-world/IoT/robotics scope is deliberately undecided.

## 22. Decision governance

Meaningful changes to any of these require updating PLAN.md first:
- durable storage/persistence
- domain ownership
- model/provider authority
- autonomy/wake policy
- digital Hands scope
- safety/approval boundaries
- self-improvement merge rules
- economic/financial authority
- phase order/dependencies
- multi-device/cloud/physical-world direction

Implementation may refine internal details that do not change these boundaries, but must not quietly create a second architecture.

## 23. Decision log

**2026-10-03 — Personal-first direction.** Build Aslam's personal Freya first; keep commercializable boundaries.  
**2026-10-03 — One encrypted structured store.** Canonical persistence becomes one per-user SQLCipher `freya.db`; large files remain outside.  
**2026-10-03 — Event journal remains separate.** Append-only security/event fabric is not folded into SQLCipher.  
**2026-10-03 — Custom durable stores retire.** Brain/Context/Personality/Skills/Life/etc. migrate to the Vault architecture; no permanent dual format.  
**2026-10-03 — Migration is system-owned now.** Prototype data is disposable; Freya/model does not autonomously migrate data.  
**2026-10-03 — Experience is first-class.** Experience remains distinct from Life and Skills.  
**2026-10-03 — Phase 20 is derived only.** Unified Conscious Context owns no durable truth.  
**2026-10-03 — Hands narrowed.** Browser, controlled terminal, clipboard, download/upload first; no screenshots/global screen capture or broad computer control yet.  
**2026-10-03 — Vault hard deny.** Digital Hands cannot access Vault/keyring/protected backup paths.  
**2026-10-03 — Event/heartbeat autonomy only.** No hidden continuous reasoning loop; deterministic gates precede model calls.  
**2026-10-03 — Self-improvement uses staging.** Generated changes live on freya-dev/freya-staging or isolated branches, pass tests/review and require owner merge approval.  
**2026-10-03 — Runtime providers.** NanoGPT primary, OpenCode API secondary for now; provider-independent Model Gateway remains canonical.  
**2026-10-03 — Economic scope.** Phase 32 is research/simulation/paper trading only; real capital needs a future explicit decision.  
**2026-10-03 — Enterprise target.** Phase 33 targets autonomous operation of the owner-controlled Webzone business/project inside approvals.  
**2026-10-03 — One device for now.** Multi-device/cloud/physical-world expansion is deferred.  
**2026-10-03 — Adult/Chibi semantics.** Same Freya identity: Adult for immersive/autonomous doing, Chibi for collaborative small-footprint co-working.  
**2026-10-03 — PLAN.md is canonical.** Architecture changes update this file before code.  
**2026-10-03 — Immediate order.** PLAN -> final Phase 19 integration -> SQLCipher Vault -> adapt 21 -> adapt 22 -> adapt 20 -> real alpha wiring/test -> Phase 23 onward.
