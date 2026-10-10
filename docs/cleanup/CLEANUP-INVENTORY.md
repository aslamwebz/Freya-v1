# CLEANUP INVENTORY — evidence-based baseline

Worktree: `C:\Users\you\Desktop\AI\.freya-worktrees\freya-cleanup`
Branch: `freya-cleanup` @ `4453563` ("feat(learning): implement failure learning and corrective planning phase 3c")
Status at inventory time: clean, except untracked `docs/cleanup/`.
Original Freya worktree: `C:\Users\you\Desktop\AI\Freya` @ `34bd80f` (`feat/mind-missions-integration`) — **not read, not written, not touched.**

Every row below cites a path and a line number or a command that produced the evidence. Rows marked
**HYPOTHESIS** are not yet proven and are treated as such until a test or a build confirms them.

---

## 0. Environment notes that affect reproducibility

These are properties of this machine's shell, not of the repository. No repo file was changed for them.

| Finding | Evidence | Handling |
| --- | --- | --- |
| `npm ci` fails with `ERR_INVALID_ARG_TYPE: The "file" argument must be of type string` when spawning lifecycle scripts | npm debug log `2026-10-10T01_04_59_754Z-debug-0.log` line 422 → `normalizeSpawnArguments` | Root cause: `$env:ComSpec` is **empty** in this shell. npm falls back to `ComSpec` on Windows for `spawnWithShell`. Fixed per-invocation with `$env:ComSpec="C:\Windows\System32\cmd.exe"`; no repo change. |
| `better-sqlite3` native binding | `node_modules/better-sqlite3/build/Release/better_sqlite3.node` present after re-run | Builds once `ComSpec` is set. Native SQLCipher assets under `native/` are untouched. |
| `electron/dist/electron.exe` missing after `npm ci` and after `npm rebuild electron` (reported "rebuilt dependencies successfully" without downloading) | directory check | Ran `node node_modules/electron/install.js` directly. Electron E2E is therefore runnable here. |
| Node 24.6.0, npm 11.5.1 | `node --version`, `npm --version` | Matches `packageManager: npm@11.5.1` in `package.json`. |

**Consequence for CI:** `.github/workflows/verify.yml:54` runs plain `npm ci` on `ubuntu-latest`.
That is a different environment and this defect is Windows-shell-specific. Do **not** "fix" it in
the repo on the strength of this evidence alone. See C5 row `npm ci` robustness.

---

## 1. Baseline gate results (recorded, not masked)

All commands run in this worktree on Node 24.6.0 after dependency install.

### 1.1 Typecheck — PASS

```
npm run typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.electron.json --noEmit && tsc -p tsconfig.core.json --noEmit
(exit 0, no output)
```

Three projects, all clean: renderer (`tsconfig.json`), Electron (`tsconfig.electron.json`), Core
(`tsconfig.core.json`). `npm run extension:typecheck` was **not** run at baseline (needs
`npm run extension:verify`; deferred to C3).

### 1.2 Lint — FAIL, 16 pre-existing errors

`npm run lint` → `eslint .` → **16 errors, 0 warnings** (1 auto-fixable). Exact list:

| File | Line:Col | Rule |
| --- | --- | --- |
| `bin/freya-mcp.mjs` | 162:21, 167:9 | `no-undef` (`setTimeout`, `clearTimeout`) |
| `bin/freya.mjs` | 200:21, 205:9 | `no-undef` (`setTimeout`, `clearTimeout`) |
| `electron/control/server.ts` | 32:1 | `@typescript-eslint/consistent-type-imports` |
| `scripts/live-acceptance-srilanka.mjs` | 112:20, 167:20 | `no-undef` (`document`) |
| `scripts/live-acceptance-srilanka.mjs` | 120:11 | `@typescript-eslint/no-unused-vars` (`chatContent`) |
| `scripts/live-acceptance-srilanka.mjs` | 288:13 | `no-empty` |
| `scripts/live-browser-reuse.mjs` | 23:5 | `preserve-caught-error` |
| `scripts/run-live-acceptance.mjs` | 46:46 | `no-empty` |
| `scripts/srilanka-live-test.mjs` | 40:15, 42:5, 101:12 | `no-empty`, `preserve-caught-error`, `no-unused-vars` |
| `tests/core/failure-learning.test.ts` | 182:29, 231:29 | `@typescript-eslint/no-explicit-any` |

Two of these are **not** cosmetic and are evidence of a real gap:
- `eslint.config.js:8` ignores `.scratch/**` but the `bin/*.mjs` and `scripts/live-*.mjs` files are
  tracked source, so they must keep linting. The failures are genuine: `bin/freya.mjs` and
  `bin/freya.mcp.mjs` use `setTimeout` without the Node globals being applied — the CLI glob at
  `eslint.config.js:40` covers `scripts/**` and `electron/**` and `tests/**` and root `*.mjs`, but
  **not `bin/**`**. That is a config gap, not 4 broken call sites.
- `scripts/live-acceptance-srilanka.mjs` uses `document` but is not in the Playwright dual-globals
  list at `eslint.config.js:55`. Second config gap.

Both are C3 fixes (align eslint config), and they must **add** coverage, not silence rules.

### 1.3 Tests — FAIL, 8–10 pre-existing failures (run-to-run variance)

```
npx vitest run tests/unit tests/core tests/host tests/qualification tests/red-team
```
Two consecutive runs at the same commit: run A reported `10 failed | 9478 passed`, run B (JSON
reporter) reported `8 failed | 9482 passed`. Total 9496 either way.

Run B failure list (exact):

| File | Failing test |
| --- | --- |
| `tests/core/audit-privacy.test.ts` | the activity feed is metadata too — describes a turn without quoting it |
| `tests/core/chat-missions-integration.test.ts` | fails unreachable sources honestly and stops after one bounded revision |
| `tests/core/mind.test.ts` | A — an explicit user turn authorises the turn through a bounded one-call grant |
| `tests/core/mind.test.ts` | Phase 4 experience isolation keeps recalled-context metadata attached to the correct concurrent turn |
| `tests/core/nanogpt-chat.test.ts` | real turns carry the compiled context — the second turn sends identity, history and the current question |
| `tests/core/personality-production-assembly.test.ts` | recovered state actually feeds the turn path — a restarted Core honours a preference it recovered, in the same single call |
| `tests/unit/shell.test.tsx` | Freya shell switches the presence state from the demo control |
| `tests/unit/shell.test.tsx` | Freya shell drives the design lab from the keyboard |

Run A additionally reported 2 failures not present in run B (10 − 8), which is **evidence of
flakiness or ordering sensitivity**, not a stable defect. Treat the 8 as the reproducible floor and
the 2 as an open C0/C2 question. Do not "fix" a flaky test by loosening its assertion.

### 1.4 Not run at baseline (recorded as skipped, with reason)

| Check | Why skipped |
| --- | --- |
| `npm test` (= `test:chat`) | See §3 finding 3.1 — it is 6 paths, not a real gate. Superseded by the full scoped run. |
| `npm run build` | Deferred to C1 first gate; recorded in `CLEANUP-VERIFICATION.md`. |
| `npm run test:e2e` | Requires a virtual display; `xvfb-run` unavailable on Windows. |
| `npm run qualify` | Re-runs every gate; ~45 min. Not run until a milestone needs it. |
| `npm run test:chat-live*` | **Network + live paid-model calls. Out of bounds by owner instruction.** |
| `npm run core:model-probe` | **Paid model call. Out of bounds by owner instruction.** |
| `npm run extension:*` | Separate extension project; deferred to C3. |

---

## 2. Size and shape of the tree

Largest tracked source files (lines, via `Get-ChildItem … | Measure-Object -Line`):

| Lines | Path |
| --- | --- |
| 11152 | `core/index.ts` |
| 3373 | `core/events/validate.ts` |
| 3228 | `core/events/envelope.ts` |
| 2798 | `electron/preload.ts` |
| 2275 | `electron/main.ts` |
| 2155 | `electron/coreHost.ts` |
| 1887 | `core/work/engine.ts` |
| 1762 | `core/consciousness/projection.ts` |
| 1754 | `core/missions/engine.ts` |
| 1712 | `core/missions/autonomy/runtime.ts` |
| 1696 | `core/mind/mind.ts` |

Domain directories under `core/`: 56. Renderer directories under `src/`: 7 (`app`, `core`, `platform`,
`presence`, `styles`, `ui`, `ui-v2`, `voice`). `scripts/`: 44 files. `tests/`: 6 subtrees.

**The brief names four blobs** (`core/index.ts`, `electron/preload.ts`, `electron/main.ts`,
`electron/coreHost.ts`). Line count alone is not a defect: `core/index.ts` is a composition root whose
job is to wire 56 domains, and `core/events/validate.ts` / `envelope.ts` at ~3.3k lines each are a
closed event schema where a smaller file would mean a weaker validator. C4 is explicitly scoped to
*bounded high-value* extractions; see §4.

---

## 3. Findings that drive the phases

### 3.1 C1-A — `localUnrestrictedMode()` is permissive by default (SECURITY, default-deny violated)

`electron/main.ts:212-215`

```ts
function localUnrestrictedMode(): boolean {
  if (process.env.FREYA_LOCAL_UNRESTRICTED === '0') return false
  return process.env.FREYA_LOCAL_UNRESTRICTED === '1' || !app.isPackaged
}
```

Read literally: an **unpackaged** build is unrestricted unless the operator explicitly opts *out*
(`=0`). The comment at `electron/main.ts:207-211` states this is deliberate, so this is a documented
decision that the audit is challenging — not an undiscovered bug.

Blast radius of the flag, all consumers confirmed:

| Line | Consumer | What `true` widens |
| --- | --- | --- |
| `electron/main.ts:232` | `buildDeviceHandsSeam()` | Device Hands policy becomes `{localUnrestricted: true}` with **five empty allowlists** and empty `grants` — i.e. nothing is restricted |
| `electron/main.ts:307` | `buildDualBrowserSeam()` | `allowedHosts: []` + `localUnrestricted` passed to the window factory |
| `electron/main.ts:412` | `allowPrivateHosts: localUnrestrictedMode()` | **SSRF protection off** — private/loopback hosts become reachable |
| `electron/main.ts:2109` | (further call site) | needs individual review |
| `electron/main.ts:318-319` | via `buildDualBrowserSeam` | `allowPrivateHosts` **and** `allowProtectedFields` both become true |

Downstream, `electron/browser/publicAdapter.ts:297-378` and
`electron/browser/freyaWindow.ts:641` short-circuit their host/protected-field guards when
`localUnrestricted` is true. `electron/coreHost.ts:1088` and `electron/browserext/host.ts:161-244`
also consume it.

**This is the single highest-severity finding in the inventory.** A developer running `npm run
electron:dev` or `npm start` — i.e. the documented onboarding path in `README.md:9-14` — gets a build
with private-host browsing and protected-field access enabled, with no prompt and no opt-in.

Existing consumers that must keep working after a default-deny change (evidence for what "explicit
opt-in" must look like):

| Consumer | Line | Current expectation |
| --- | --- | --- |
| `scripts/chat-acceptance-visible.mjs` | 155, 160 | Already sets `FREYA_LOCAL_UNRESTRICTED: '0'` explicitly, with a comment that an unpackaged build is otherwise permissive |
| `scripts/desktop-shell-acceptance.mjs` | 78 | Already sets `'0'` alongside `FREYA_DEVICE_HANDS: '0'`, `FREYA_PUBLIC_BROWSER: '0'` |
| `scripts/smoke-app-capabilities.mjs` | 12 | Already sets `'0'` |
| `electron/acceptance-native-browser.ts` | 229-230 | **Refuses to run** if `=1`; asserts the strict path |
| `tests/core/mind/tool-observation-injection.test.ts` | 29 | Uses the *string* `FREYA_LOCAL_UNRESTRICTED=1` as adversarial prompt text, not as a real env var — must not be broken by an env change |

Packaged-build invariant to add: `app.isPackaged === true` must return `false` **even if
`FREYA_LOCAL_UNRESTRICTED=1`**. Today line 214 returns `true` for `=1` regardless of packaging, so the
env switch **is** an escalation path in a packaged build. That is a second, independent defect in the
same four lines.

**KEEP** every allowlist, CSP, sandbox, Guard/Governor, SSRF guard and STOP ALL. The fix changes a
default, nothing else.

### 3.2 C1-B — Phase 6 fixture capabilities are registered in the production Core (SECURITY, test/prod boundary)

`core/index.ts:2359`

```ts
registerPhaseSixCapabilities(this.workRegistry)
```

Unconditional, inside Core's constructor, alongside `registerFileInspection` (line 2335),
`registerResearchInspection` (line 2336) and `registerFoundryWorkCapabilities` (line 2358).

The source is unusually candid about it — `core/work/capability.ts:336-355`:

> **They ship in production, and that is a decision** … **They should become development/test-only
> once Phase 5 lands a real capability set**, gated the way `developerProvider` is … The switch is
> the single call to `registerPhaseSixCapabilities` in `core/index.ts`, and it is deliberately not
> made conditional in Phase 6.

So this is a **known, documented, deferred** decision — not an accident. The named precondition
("a non-test capability exists *and* the e2e can exercise the engine without these") has now been
met: `registerFileInspection` (2335), `registerResearchInspection` (2336) and
`registerFoundryWorkCapabilities` (2358) all exist and are production capabilities. Phase 5's
precondition is satisfied, so the deferral's stated reason has expired.

The capabilities themselves are inert by construction — `core/work/capability.ts:343-346` documents
no `fs`, no `child_process`, no socket, no model access. Severity is therefore **low on impact,
real on principle**: a renderer `work.run.create` or a Skills workflow can name `test.record` /
`test.failing` / `test.slow` / `test.unverifiable` / `test.consequential` in a shipped Core, and
`test.failing` / `test.always-fails` are *deliberate failure generators* living in the production
capability surface.

Registered names, all in `core/work/capability.ts`: `test.record` (379), `test.failing` (411),
`test.unverifiable` (430), `test.slow` (455), `test.consequential` (500), `test.record.matches` (539),
`test.exit.waited` (570), `test.change.applied` (587), `test.always-fails` (602).

Test dependency surface that must be preserved (all construct a real `Core`, so all depend on the
unconditional registration):

`tests/core/chat-missions-integration.test.ts` (2 `createCore`), `tests/core/hands-redteam/harness.ts`,
`tests/core/mind-missions-integration.test.ts` (4), `tests/core/mission-autonomy-loop.test.ts`,
`tests/core/mission-core.test.ts` (6), `tests/core/office.test.ts` (3),
`tests/core/skills-core.test.ts` (6), `tests/core/skills-model-independence.test.ts` (2),
`tests/core/work.test.ts` (8), `tests/core/workforce/harness.ts` (2),
`tests/red-team/office-redteam.test.ts`, `tests/red-team/skills/harness.ts`.

Additionally `tests/host/coreHost.test.ts:167-201` and `tests/host/skillsBridge.test.ts:36` name
`test.record` — these go through `electron/coreHost.ts:1177` `createCore`, so a CoreOptions opt-in
must be plumbed through `CoreHostOptions` too, **or** those tests must be changed. Decide in C1 and
record which.

Tests that build their **own** registry and already call `registerPhaseSixCapabilities` directly —
these are unaffected by any Core change: `tests/core/work.test.ts:2331,2840,2882`,
`tests/core/work-lifecycle.test.ts:500,513`, `tests/core/workforce/harness.ts:418`,
`tests/core/hands-redteam/harness.ts:288` (the last is conditional on `options.bareRegistry`).

Precedent for the correct shape already exists in the same file: `CoreOptions.developerProvider`
(`core/index.ts:421-436`) is described as *"Named for what it is and opt-in, because the failure mode
it guards against is a build that appears to work while answering from a canned string. It is never
inferred from a debug flag, a test runner, or an absent credential."* Copy that discipline.

**Decision required in C1:** a named `CoreOptions` boolean, default `false`, never inferred from
`NODE_ENV`/`VITEST`/`app.isPackaged`. Explicitly set by the 12 files above.

### 3.3 C2-A — `lifeLoopVerify` conflates "not open" with "verified success" (CORRECTNESS)

`core/index.ts:4830-4846`, documented at 4820-4829.

The doc comment is honest about the design: *"A reference Core does not recognise is reported as
satisfied, because 'nothing is known to still be running' is the true statement and a fabricated doubt
would burn a retry for no reason."*

The defect is that the code then **narrows "nothing known to still be running" into
`holds: true`**. `holds` is consumed as a verification verdict (`LifeLoopPorts['verify']` at
`core/index.ts:4629`). So an unrecognised reference, or a run that **failed** rather than settled,
both return `holds: true` / `code: 'reference-settled'`.

`attentionGoalOpen` (`core/index.ts:5026-5034`) shows why this is genuinely lossy:

```ts
private attentionGoalOpen(goalRef: string): boolean {
  if (this.missionEngine?.exists(goalRef) === true) return true
  const run = this.workEngine?.snapshot().runs.get(goalRef)
  if (run !== undefined && !isTerminalRunStatus(run.status)) return true
  return false
}
```

Three states collapse into two: **still running**, **terminal** (succeeded *or failed* — both satisfy
`isTerminalRunStatus`), and **unknown** (not a Mission, not a Run). The verify port cannot tell a
failed Mission from a settled one. The brief is explicit that the fix must claim *"verify event
claimed, NOT arbitrary mission success"* — i.e. `holds` should mean *the loop's claim was verified*,
not *the thing succeeded*. Discriminating settled / failed / unknown is required; renaming to
quiescence is the acceptable alternative if the interface genuinely only means that.

Caller count is small (`core/index.ts:4629` only) and `lifeLoopVerify` is `private`, so the blast
radius is contained. **Do not** break the `escalation-delivered` branch (4833-4843) — that one is
already discriminating correctly (`attention-decided` vs `attention-decided-nothing`).

### 3.4 C2-B — `releaseMissionAssignments` reads a truncated projection and swallows failures (RELIABILITY)

`core/index.ts:5767-5788`, called from exactly one place: `core/index.ts:5734` inside
`advanceMissionDecision`.

Two documented, self-admitted weaknesses:

1. **Truncation (line 5776-5778):** *"Read through the **workers**, which is the only place a retained
   assignment list appears on this projection. `WorkerView.assignments` is a retention slice, so a
   Mission with more steps than the slice holds could leave some open."*
   The authoritative store exists and is reachable: `WorkforceState.assignments` is
   `ReadonlyMap<string, AssignmentRecord>` (`core/workforce/types.ts:729`), and the projection already
   reports the gap honestly as `assignmentsRetained` / `assignmentsTotal` / `assignmentsHidden`
   (`core/workforce/types.ts:647-650`, populated at `core/workforce/projection.ts:195-197`). So the
   board *knows* rows are hidden while the closer silently misses them. The failure mode the comment
   names downstream is a Mission blocking on `no_capable_worker`.

2. **Silent swallow (line 5785):** `await scope.cancelAssignment(...).catch(() => undefined)`.
   The rationale at 5764-5765 is sound (*"a Mission's outcome does not depend on its paperwork"*) —
   but swallowing with **zero diagnostics** is not the same as not failing. There is no log, no event,
   no counter, so the leak is unobservable.

Cancellation is already idempotent in the good sense: `core/workforce/engine.ts:259` maps
`cancelAssignment` to `settleAssignment(assignmentId, 'cancelled', ...)`, and the caller skips
already-terminal assignments via `isTerminalAssignmentStatus` (`core/index.ts:5784`). Restart recovery
exists as `reconcileExpiredAssignments` (`core/workforce/engine.ts:886-907`) and
`reconcileAfterRecovery` (190-217) — but `reconcileExpiredAssignments` is **expiry**-based, so a
cancelled-once-but-leaked assignment is not what it reaps.

**Required C2 outcome:** enumerate authoritatively; keep cancellation idempotent; add diagnostics
that make a leak visible without failing the Mission; add a restart-recovery test. No false success,
no runaway retry.

### 3.5 C3-A — README is two phases stale

`README.md:6-7`: *"Phase 0 is a real desktop shell… it is honest about the fact that there is no model
behind it yet."*
`README.md:83-86` **"Phase 0 boundaries"**: *"Not implemented, and not stubbed: any model provider,
agents, swarms, missions, search, the vault, terminals, browser automation, connectors, the cognition
governor, or the security engine."*

Every item on that "not implemented" list **is** implemented at this commit: NanoGPT provider
(`README.md:28-53` itself documents it), Mind, Missions, search/research, encrypted Vault, browser
automation, connectors, cognition Governor, security engine. `docs/` carries 58 files through
`PHASE-51.md`.

`README.md:70` is also literally duplicated: *"…a four-function preload bridge, and every permission
request denied, and a four-function preload bridge."* `electron/preload.ts` is 2798 lines, so
"four-function" is also stale as a count.

The `README.md:74-80` documentation table lists 4 documents; `docs/` has 58. `docs/ARCHITECTURE.md`,
`docs/ROADMAP.md`, `docs/CORE-EVENTS.md`, `docs/PRODUCT.md`, `docs/DECISIONS.md`,
`docs/FREYA-CONSTITUTION.md` all exist and are unreferenced from the index.

### 3.6 C3-B — `LiveTesting.md` points at a path and branch that do not exist here

| Line | Current text | Reality |
| --- | --- | --- |
| 5 | Work in `C:\Users\you\Desktop\AI\Freya-main` on branch `experiment/deepseek-v41-freya-20261009` | This worktree is `.freya-worktrees/freya-cleanup` on `freya-cleanup`; the original is `Freya` on `feat/mind-missions-integration` (`git worktree list`) |
| 12, 24, 38 | `cd C:\Users\you\Desktop\AI\Freya-main` | Path does not exist in this worktree context |
| 70 | *"commit on the current experiment branch only. Keep `main` untouched."* | References a branch this repo no longer has |

`.github/workflows/verify.yml:10,14` triggers on `phase-5-research` and
`runtime/phase49-release-evaluation`, described in-file as branches that "live on their own branch until
they are reviewed and merged". Both are **legacy branch triggers** per C3.

Historical `docs/superpowers/plans/` and `docs/superpowers/specs/` documents reference
`425fea98…`, `phase-5-research`, and an owner brief path under `C:\Users\you\.codex\attachments\`.
**These must be marked archival, not rewritten** — they record what was actually decided at the time.

### 3.7 C3-C — root launchers are tracked binaries with narrow consumers

| File | Size | Tracked | Referenced by |
| --- | --- | --- | --- |
| `Freya.exe` | 5120 B | yes | `scripts/FreyaLauncher.cs:1,7` (its source), `scripts/dev-desktop.mjs:9,94,96`, `startup.md:26` |
| `freyadebugging.exe` | 5120 B | yes | `control.md:27,36,47`, `startup.md:13,43,69` |
| `Freya.cmd` | — | yes | not found by grep |
| `FreyaChatDebug.cmd` | — | yes | not found by grep |
| `bin/freya.cmd` | — | yes | not found by grep |

`scripts/FreyaLauncher.cs:7` gives the exact rebuild command
(`csc.exe -nologo -target:winexe -out:Freya.exe scripts\FreyaLauncher.cs`), so the `.exe` is a build
artifact of a tracked source file, checked into the repo root. Removing it is only safe if
`dev-desktop.mjs` / `startup.md` / `control.md` are updated in the same change — they are its only
documented consumers. **ARCHIVE-CANDIDATE, not yet decided.** No packaging test references them
(searched `tests/` and `scripts/build-*.mjs`: no hits), which supports removal, but the brief says
remove **only after** reference/packaging verification, and that verification is C3 work.

### 3.8 C3-D — `npm test` is a 6-path smoke test, and CI runs everything

| Entry point | Definition | Coverage |
| --- | --- | --- |
| `npm test` → `test:chat` | `scripts/test-scope.mjs:4-11` `FAST_CHAT` = 6 paths under `tests/unit/app`, `tests/unit/chat` | chat-only |
| `test:chat:integration` | `scripts/test-scope.mjs:13-32` `CHAT_INTEGRATION` = 6 + 18 paths | chat + browser/research/mind/host |
| `npm run verify:full` (CI entry, `.github/workflows/verify.yml:57`) | `typecheck && lint && test:full && build`; `test:full` = `vitest run` with no path filter → `vite.config.ts:33-44` | **all 518 files / 9496 tests** |

So CI is correct and strong. The risk is purely **local**: a developer typing `npm test` gets 6 paths
and a green tick. `README.md:24` advertises it as *"unit and DOM tests (Vitest)"*, which overstates
it. Worth an explicit note in the docs; changing the default `npm test` target is a policy decision
for the owner, so C3 documents rather than changes.

### 3.9 C5-A — `src/ui/` is NOT dead (HYPOTHESIS REFUTED)

The brief anticipated `src/ui/` might be removable. **It is not.** Evidence:

- `src/main.tsx:1-16` — the shipping renderer entry `index.html:140` loads `/src/main.tsx`, which
  dynamically imports `./app/entry` by default and `./ui-v2/entry` only for `?ui=v2`. So neither
  `src/ui` nor `src/ui-v2` is on the default path.
- **But `src/ui` is imported by live non-test source:**
  - `src/core/useConversation.ts:2` → `import { shellStore } from '../ui/store'`
  - `src/voice/runtime.ts:4` → `import { openMicrophone, requestMicrophonePermission, MicrophoneError, type MicCapture } from '../ui/surfaces/microphone'`
- **And by 22 test files**, including `tests/unit/voice/runtime-lifecycle.test.ts:5-6`, which
  `vi.mock`s `../../../src/ui/surfaces/microphone`.

**Conclusion: KEEP `src/ui/` in full.** Deleting it would break the voice path and ~22 tests. This
refutes the hypothesis rather than confirming it. `src/ui-v2` is likewise **KEEP** — the brief
already warns of 41+ shared imports with App Mode, and `adult.html:14` loads
`/src/ui-v2/assets/freya-portrait.webp`.

Also **KEEP regardless of any reachability argument**: `presence.html:83` → `src/presence/desktop/presenceMain.tsx`
(a distinct Vite entry, `vite.config.ts:19-24`), `adult.html` (a third entry, `vite.config.ts:23`),
and the Electron preload build entry (`scripts/build-electron.mjs`, referenced by
`package.json:11` `"main": "dist-electron/main.cjs"`).

### 3.10 C5-B — Core domain reachability (do NOT delete on this basis)

Reference counts from `git grep` across `core/index.ts electron src core scripts` (runtime graph) vs
`tests` (test graph):

| Domain | Runtime refs | Test refs | Classification |
| --- | --- | --- | --- |
| `multidevice` | 0 | 2 | FUTURE ROADMAP — test-only, **retain** |
| `resilience` | 0 | 3 | FUTURE ROADMAP — test-only, **retain** |
| `sovereign` | 0 | 3 | FUTURE ROADMAP — test-only, **retain** |
| `evolution` | 0 | 4 | FUTURE ROADMAP — test-only, **retain** |
| `threshold` | 0 | 8 | FUTURE ROADMAP — test-only, **retain** |
| `memory-identity` | 1 | 4 | retain (roadmap) |
| `enterprise` | 1 | 1 | retain (roadmap; brief names it explicitly) |
| `executive` | 1 | 0 | retain (roadmap) |
| `senses` | 1 | 0 | retain (roadmap) |
| `natural-presence` | 1 | 0 | retain (roadmap) |
| `longhorizon` | 2 | 6 | retain (roadmap) |
| `relationship` | 2 | 0 | retain |
| `improvement` | 2 | 0 | retain (brief names it) |
| `acquisition` | 2 | 0 | retain |
| *(all remaining 42 domains)* | 3–164 | 0–141 | KEEP — reachable |

**Zero domains are proposed for deletion.** The brief forbids deleting these domains merely because
the runtime graph does not reach them, and the reference counts confirm they are still under active
test development. Any `core/<domain>` removal is **out of scope** absent a stronger proof (e.g. an
owner roadmap statement superseding it) than "no runtime import".

### 3.11 C3-E — CI runs the suite twice by design

`.github/workflows/verify.yml:59-76` runs `npm run release:check`, `release:manifest`, `test:e2e`, then
`npm run qualify`, with `timeout-minutes: 45` raised at line 41 to absorb it. The comment at 37-40
says this is deliberate ("the roll-up has to be computed from real exit codes, not from CI's opinion
of them"). **This is a documented decision, not duplicate-pass debt.** Do not "deduplicate" it.
Recorded here so it is not mistaken for cleanup opportunity.

The genuine CI gaps are: (a) legacy branch triggers (§3.6), (b) the `test:chat-missions` acceptance
lane (`package.json:70-71`, `electron/acceptance-chat-missions.ts`) has **no workflow step** — it is
in `package.json` but not in `verify.yml`, so it cannot rot silently in CI.

---

## 4. KEEP / CONSOLIDATE / ARCHIVE-CANDIDATE / FIX matrix

`KEEP` = protected, do not touch. `FIX` = code change with tests. `ARCHIVE-CANDIDATE` = may be removed
or archived **only** with reference + packaging verification recorded. `CONSOLIDATE` = merge duplicates.

### 4.1 KEEP — protected product surface (owner instruction + evidence)

| Path | Why |
| --- | --- |
| `core/mind`, `core/brain`, `core/learning`, `core/missions`, `core/work` | Mind, Brain, Learning, Missions, Work |
| `core/lifeloop`, `core/life`, `core/workforce`, `core/consciousness`, `core/attention` | LifeLoop + Workforce |
| `core/vault/**`, `native/**` | Encrypted Vault, SQLCipher assets — **never touch** (owner instruction) |
| `core/security`, `core/safety`, `core/guard*` | Guard/Governor, endpoint allowlists |
| `core/browser`, `electron/browser/**`, `core/browserext`, `electron/browserext` | Browser + SSRF protection |
| `core/events/**` | EventFabric — `validate.ts` (3373) + `envelope.ts` (3228) are a closed schema |
| `src/app/**` (80 files), `src/ui-v2/**` (49 files) | App Mode default; ui-v2 shares 41+ imports, `adult.html` loads its asset |
| `src/ui/**` (35 files) | **KEEP** — live via `src/voice/runtime.ts:4` and `src/core/useConversation.ts:2`, plus 22 tests (§3.9) |
| `src/presence/**`, `presence.html`, `adult.html`, `index.html` | Three distinct Vite entries (`vite.config.ts:19-24`) |
| `electron/preload.ts` | Preload firewall; named as a C4 extraction candidate only |
| `electron/voice*`, `core/voice`, `electron/tray`-equivalent, Adult/Chibi assets | Voice, tray, Adult/Chibi modes |
| `electron/acceptance-chat-missions.ts`, `scripts/build-chat-missions-acceptance.mjs` | chat-Missions acceptance coverage |
| `core/control*`, `electron/control/**`, `electron/coreHost.ts:1025-1088` | Control plane + browser authority |
| `.github/workflows/verify.yml` `verify:full` + `qualify` steps | Strong gate; the double run is deliberate (§3.11) |

### 4.2 FIX — code changes with targeted tests

| ID | Path:line | Defect | Phase |
| --- | --- | --- | --- |
| **C1-A** | `electron/main.ts:212-215` | Unpackaged defaults permissive; `=1` escalates even when packaged | C1 |
| **C1-B** | `core/index.ts:2359` | `registerPhaseSixCapabilities` unconditional in production Core | C1 |
| **C2-A** | `core/index.ts:4830-4846`, `5026-5034` | `holds: !stillOpen` asserts success from quiescence; failed ≡ settled ≡ unknown | C2 |
| **C2-B** | `core/index.ts:5767-5788` | Retention-slice enumeration + silent `catch` | C2 |
| **C3-A** | `README.md:6-7, 70, 74-80, 83-86` | Two phases stale; duplicated phrase; 4-doc table vs 58 | C3 |
| **C3-B** | `LiveTesting.md:5,12,24,38,70` | Dead path + dead branch | C3 |
| **C3-C** | `verify.yml:10,14` | Legacy branch triggers (`phase-5-research`, `runtime/phase49-release-evaluation`) | C3 |
| **C3-F** | `eslint.config.js:40,55` | `bin/**` and `scripts/live-acceptance-srilanka.mjs` get no globals block → 16 lint errors | C3 |
| **C3-G** | `package.json` / `verify.yml` | `test:chat-missions` lane absent from CI | C3 |
| **C3-H** | `scripts/run-live-acceptance.mjs:46`, `scripts/live-browser-reuse.mjs:23`, `scripts/srilanka-live-test.mjs:40,42,101` | `no-empty` / `preserve-caught-error` / unused var | C3 |

### 4.3 ARCHIVE-CANDIDATE — evidence gathered, removal NOT yet authorised

| Path | Evidence for | Blocker before removal |
| --- | --- | --- |
| `Freya.exe` | Build artifact of tracked `scripts/FreyaLauncher.cs:7`; no test or `build-*` script reference | Must update `scripts/dev-desktop.mjs:9,94,96` and `startup.md:26` in the same change; `startup.md:26` is user-facing |
| `freyadebugging.exe` | Same kind of artifact; no test reference | Must update `control.md:27,36,47` and `startup.md:13,43,69` |
| `Freya.cmd`, `FreyaChatDebug.cmd`, `bin/freya.cmd` | Tracked, zero grep references outside themselves | Confirm nothing shells out to them; `bin/freya.cmd` may be `bin/freya.mjs`'s wrapper |
| `docs/superpowers/plans/*`, `docs/superpowers/specs/*` | Historical record; reference dead branches/commits | **Mark archival, do not rewrite** (owner instruction) |
| `docs/PHASE-*.md` (58 files) | Historical phase record | **Mark archival, do not rewrite** |

### 4.4 CONSOLIDATE — no verified duplicates found

No two tracked files were found to be byte-duplicate or dead-duplicate. The *apparent* duplication in
`verify.yml` (§3.11) and `README.md:70` is intentional or a typo, not a code duplicate. **No
consolidation action is proposed.** Recorded so the category is not padded.

---

## 5. Phase-by-phase acceptance criteria (derived, verifiable)

| Phase | Done when |
| --- | --- |
| **C1-A** | `localUnrestrictedMode()` returns `false` by default on unpackaged builds; returns `false` on **packaged** builds even with `FREYA_LOCAL_UNRESTRICTED=1`; existing acceptance scripts (`chat-acceptance-visible`, `desktop-shell-acceptance`, `smoke-app-capabilities`, `acceptance-native-browser`) still pass **without silently altered assumptions**; ≥1 new negative test proves an unpackaged default build is restricted |
| **C1-B** | `registerPhaseSixCapabilities` unreachable from a default `Core`; new test proves a renderer `work.run.create` naming `test.record` is refused in a production registry; the 12 `createCore` test files + 2 host tests explicitly opt in and all still pass |
| **C2-A** | `lifeLoopVerify` discriminates settled / failed / unknown; no `holds: true` is produced for a failed or unknown reference; `escalation-delivered` semantics unchanged; targeted tests added |
| **C2-B** | All linked assignments reconciled from the authoritative store, not the retention slice; cancel idempotent; failures logged (not thrown); restart-recovery test added |
| **C3** | README, `LiveTesting.md` current; archival banner on historical docs; legacy CI triggers resolved; eslint config **extended** (not weakened); `test:chat-missions` in CI with no network/paid-model calls |
| **C4** | Only bounded extractions; `core/index.ts`, `electron/preload.ts`, `electron/main.ts`, `electron/coreHost.ts` public contracts unchanged; behaviour + regression tests per extraction; **stop if risk rises** |
| **C5** | `src/ui/`, `src/ui-v2/`, `presence.html`, preload entry, `native/**`, Adult/Chibi all retained; every core domain retained with evidence; removals (if any) proven dead and covered by tests |

---

## 6. Integration risk with the original worktree (read-only observation)

The original `C:\Users\you\Desktop\AI\Freya` is at `34bd80f` on `feat/mind-missions-integration`; this
worktree is at `4453563`. **Phase 3D is in progress there and is intentionally absent here.**

- Both trees contain `tests/core/mind-missions-integration.test.ts` and
  `tests/core/chat-missions-integration.test.ts` (§3.2 lists them as Phase-6-fixture dependents).
  Those files are the most likely **conflict hotspots** for any C1-B change, because a 3D edit there
  will collide with the opt-in edit C1-B requires.
- `core/index.ts` is touched by both C1-B, C2-A and C2-B. Three C-phase commits into one 11k-line file
  makes a manual merge harder, not easier. Mitigation: keep C2-A and C2-B as separate commits.
- **No merge, rebase, push, cherry-pick or file copy is performed or authorised.** `git worktree list`
  is recorded in §3.6 as evidence only.

---

## 7. Open questions for the owner (blocking nothing in C0)

1. `npm test` → 6 paths. Should the default target widen to `test:regression`? (Docs-only in C3 absent
   an answer; a default-target change is a policy call.)
2. Two extra test failures appear intermittently between identical runs (§1.3). Accept as flaky and
   document, or chase to a root cause in C2?
3. Should `Freya.exe` / `freyadebugging.exe` be removed, or kept and documented as manually built
   artifacts? Both have live doc consumers (`startup.md`, `control.md`).
4. Is `Phase 5`'s precondition ("a non-test capability set exists and the e2e runs without the
   fixtures") formally considered met? C1-B proceeds on the evidence that it is (§3.2) and records
   the reasoning; the owner can veto.