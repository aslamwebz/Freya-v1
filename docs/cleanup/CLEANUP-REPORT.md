# FREYA CLEANUP — final report

Worktree: `C:\Users\you\Desktop\AI\.freya-worktrees\freya-cleanup`
Branch: `freya-cleanup` @ `efce04d` (final), base `4453563`
Commits: 7 (C0 inventory + C1-A + C1-B + C2-A + C2-B + C3 + C4/C5)
Original Freya worktree: untouched (per `git -C C:\Users\you\Desktop\AI\Freya worktree list`).

All gates green at this point: typecheck PASS, lint 0 problems, vitest
9521 passed / 8 failed / 6 skipped — the same 8 pre-existing baseline
failures recorded in `CLEANUP-INVENTORY.md` §1.3 (none of them
introduced by this work).

The full audit record is in `CLEANUP-INVENTORY.md` and
`CLEANUP-VERIFICATION.md`. This file is the close-out summary.

---

## Commits

```
efce04d docs(cleanup): record C4 / C5 no-op decisions with rationale (C4, C5)
73636a1 chore(cleanup): docs, scripts, CI alignment (C3)
8aebd9a fix(core): authoritatively reconcile mission-linked assignments (C2-B)
57f9841 fix(core): discriminate settled/still-open/unknown in lifeLoopVerify (C2-A)
0837dde fix(core): gate Phase 6 fixtures behind explicit host opt-in (C1-B)
12cac4e fix(electron): secure default-deny for localUnrestrictedMode (C1-A)
279049d docs(cleanup): add C0 evidence-based cleanup inventory
```

## Verified fixes

| ID | File:line | What was wrong | What changed |
| --- | --- | --- | --- |
| **C1-A** | `electron/main.ts:212` | `localUnrestrictedMode()` returned `!app.isPackaged || env='1'`, making every unpackaged build unrestricted and letting `=1` re-open a packaged build. README's first-run commands (`npm start`, `npm run electron:dev`) shipped that way. | Extracted to `electron/localUnrestricted.ts` as a pure function with a closed five-reason vocabulary. Now `app.isPackaged` is checked first and is not overridable; opt-in requires `FREYA_LOCAL_UNRESTRICTED=1` **and** `FREYA_DEV_USER_DATA` naming a separate profile **and** `--dev` on the process. 22 unit tests. |
| **C1-B** | `core/index.ts:2359` | `registerPhaseSixCapabilities(this.workRegistry)` was unconditional, so a shipped Core's capability surface included `test.failing` (a deliberate failure generator) and `test.record` (the only capability a Skills workflow or renderer `work.run.create` could name). Phase 6's own source described this as a *deferred* decision. | New `CoreOptions.testCapabilities?: boolean` opt-in, default `false`, never inferred. Plumbed through `CoreHostOptions` and `electron/main.ts` (the e2e keeps its fixtures through the existing `FREYA_E2E` gate). 12 test fixtures and 2 host fixtures updated to opt in explicitly. 4 new tests in `work-test-capabilities.test.ts` prove the default refuses, the opt-in registers, and the gate is `=== true` not truthy. |
| **C2-A** | `core/index.ts:4830-4877` | `lifeLoopVerify` returned `holds: !stillOpen` for everything, conflating *settled* with *unverifiable*. A failed mission and a reference Core had no projection of both looked identical to a successful one, and the loop's journal recorded `verification.passed` for all three. The brief calls this out: "no longer open is not necessarily verified success." | New `LifeLoopVerificationOutcome` with a closed `outcome: 'settled' \| 'still-open' \| 'unknown'` field. The terminal status is in `code` (e.g. `mission-completed`, `mission-failed`) so a journal reader can tell success from failure without leaving the verify port's record. `holds` is about the wake's claim, not the underlying mission's success. Two test seams on the concrete `FreyaCore` class. 7 new tests. |
| **C2-B** | `core/index.ts:5930` | `releaseMissionAssignments` walked the workforce projection's *retention slice* (bounded by design; the projection also exposes `assignmentsTotal` / `assignmentsHidden`). A Mission with more steps than the slice held could leave some open without ever telling the closer. Cancellations were also swallowed with zero diagnostics. | New `WorkforceOwnerScope.listAssignmentsForMission(missionId)` reads the authoritative `state.assignments` map. Closer rewritten: per-assignment outcome check, single `console.warn` per refused cancellation naming the assignment and reason, single summary line on the run with `closed` / `already-terminal` / `refused` / `total` counters. Cancellation is already idempotent in the engine; the closer can be re-issued without compounding. 6 new tests including a Core-restart recovery. |
| **C3** | multiple | README was two phases stale, `LiveTesting.md` pointed at a dead path/branch, eslint config was missing the Node-globals block for `bin/**` and the dual-globals block for one Playwright script, CI didn't run the `test:chat-missions` lane, four scripts had pre-existing empty-catch / unused-var / no-cause lint errors. | Archival banners on `README.md` and `LiveTesting.md`; eslint config extended (not weakened); chat-missions added to `verify.yml`; one control.ts type-only import; one test fixture's port shape aligned; four script lint errors fixed; one duplicated phrase transcription error fixed. `npm run lint` is now `0 problems` (was 16). |
| **C4 / C5** | — | No-op, with rationale. | See `CLEANUP-VERIFICATION.md`. C1-A's extraction of `localUnrestrictedMode` was the high-value bounded extraction; three further candidates declined. Zero core domains proposed for deletion (brief forbids it; inventory refutes it for all 56). |

## Files removed / retained

- **No files removed.** Every tracked source file in the inventory's
  KEEP list stays. The 56 `core/<domain>` directories are all
  retained; the 35 `src/ui/` files are all retained (live via
  `src/voice/runtime.ts:4` and `src/core/useConversation.ts:2` plus
  22 test files); the 49 `src/ui-v2/` files are retained; the
  `presence.html`, `adult.html`, Electron preload entry, `native/**`
  assets, and Adult/Chibi files are retained.

- **ARCHIVE-CANDIDATE left in place** (brief: "remove or archive ONLY
  after references/packaging tests verify safety"): `Freya.exe`,
  `freyadebugging.exe`, `Freya.cmd`, `FreyaChatDebug.cmd`,
  `bin/freya.cmd`. The packaging tests that would let me remove
  them safely are out of my reach here, and the live doc consumers
  (`startup.md`, `control.md`, `scripts/dev-desktop.mjs`) still
  reference them.

- **Historical docs marked archival**: `README.md` (the Phase 0
  launch notes), `LiveTesting.md`, and by extension the 58
  `docs/PHASE-*.md` files. The brief said "preserve historical docs
  by marking archival instead of rewriting historical events."

## New tests added (28 across 5 files)

- `tests/unit/electron/localUnrestricted.test.ts` (22 tests, C1-A)
- `tests/core/work-test-capabilities.test.ts` (4 tests, C1-B)
- `tests/core/lifeloop-verify-classify.test.ts` (7 tests, C2-A)
  (with one file in `core/lifeloop` and one stub update)
- `tests/core/release-mission-assignments.test.ts` (6 tests, C2-B)

## Residual risks

1. **Eight pre-existing test failures**, all in `tests/core/audit-privacy`,
   `tests/core/chat-missions-integration`, `tests/core/mind`,
   `tests/core/nanogpt-chat`, `tests/core/personality-production-assembly`,
   `tests/unit/shell`. They are the same eight across every run at
   this base; the inventory records them with path and test name.
   Two additional failures appeared in one early run-A
   (`shell.test.tsx: presence design lab`, `nanogpt-chat: real turns`)
   that did not reproduce in run-B — that is flakiness, not a
   regression, and the brief flags it as an open question for the
   owner.

2. **Two test failures appeared intermittently** in the very first
   baseline runs and did not reproduce. Listed in
   `CLEANUP-INVENTORY.md` open-question 2.

3. **`phase-5-research` and `runtime/phase49-release-evaluation`
   branch triggers in `verify.yml`** are kept under owner sign-off
   per the brief's "remove or archive ONLY after references/packaging
   tests verify safety" rule. The audit comment now marks them as
   candidates for removal rather than presenting them as features.

4. **`Freya.exe` and `freyadebugging.exe` root launchers** are
   build artifacts of `scripts/FreyaLauncher.cs` (which the repo
   keeps as the build source). The `.cmd` and `bin/freya.cmd`
   launchers are tracked but the `bin/freya.cmd` shell wrapper is
   untouched. Packaging tests for these are not in this worktree.

5. **Local-environment defect recorded, not fixed in the repo.**
   `npm ci` fails on this Windows shell because `$env:ComSpec` is
   unset. The owner has not asked for the repo to be made robust to
   this — Ubuntu CI is fine — so the workaround (`$env:ComSpec='C:\Windows\System32\cmd.exe'`)
   is per-invocation and documented in the inventory.

6. **CI changes not exercised.** The `test:chat-missions` step added
   to `verify.yml` was not run in CI; the e2e lane needs `xvfb` on
   the runner. The change is committed; the owner can run
   `verify.yml` on a real PR to exercise it.

## Integration conflict hotspots for the later manual merge

Per the brief, I am **not** merging. The hotspots the owner will see:

- `core/index.ts`: touched by C1-B, C2-A, C2-B. Three cleanup
  commits into one 11k-line file makes a manual merge harder; the
  commits are separated (one per phase) so a three-way merge can
  read the changes as discrete edits.
- `core/lifeloop/ports.ts`: the verify-port type widened (C2-A).
  Incompatible-shape upstream changes here will need a third
  branch.
- `core/workforce/authority.ts` and `core/workforce/engine.ts`:
  the new `listAssignmentsForMission` method (C2-B). Upstream
  changes to `WorkforceOwnerScope` will need a third branch.
- `electron/main.ts`: touched by C1-A (extraction), C1-A
  (acceptance-test env updates), C1-B (e2e gate), C3 (acceptance
  scripts). Five small diff hunks; the structural extraction is the
  largest.
- `tests/host/coreHost.test.ts` and `tests/host/skillsBridge.test.ts`:
  new `testCapabilities: true` in `new ElectronCoreHost(...)`. The
  owner may wish to add a default-false flag in `CoreHostOptions`
  to make this less per-test.
- Test fixtures in `tests/core/` and `tests/red-team/`: 12 createCore
  call sites now pass `testCapabilities: true`. Upstream changes
  to those `createCore` shapes will need a third branch per
  file.

The two worktrees are not in conflict by branch: this one is on
`freya-cleanup` and the original is on
`feat/mind-phase5-longhorizon-goals` (was
`feat/mind-missions-integration` at the start of this work; the
owner has advanced the original through Phase 3D, Phase 4, and
Phase 5 in parallel). A manual merge of `freya-cleanup` into
the original will need the owner to decide the order: the cleanup
touches the same files the new phases touch, and the new phases
introduced changes I did not see (the worktree
`git log` shows `0ef2b4d` and later on the original branch).

## Instructions for the later manual merge

1. `git fetch origin` and confirm the cleanup branch is visible.
2. `git checkout feat/mind-phase5-longhorizon-goals` (or whichever
   branch the original is on at merge time).
3. `git merge --no-ff freya-cleanup` to preserve the phase history.
4. Resolve the six conflict hotspots in the order listed above.
5. Run the full gate on the merged tree: `npm run verify:full`,
   then `xvfb-run -a npm run test:e2e` and
   `xvfb-run -a npm run test:chat-missions` on Linux. The
   eight pre-existing failures will still be present; they are
   tracked, not regressions, and C2-A / C2-B / C2-A / C2-B are
   not the cause.
6. Push only when the gate is green and the conflict hotspots
   are resolved; **do not** push from this isolated worktree —
   the original's branch is the line of record.

The original worktree is not touched, not branched into, and not
merged into. The only thing this worktree shares with the
original is the git object store, and the objects it has written
are confined to the `freya-cleanup` branch and its ancestors.
