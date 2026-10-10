# CLEANUP VERIFICATION LOG

Per-milestone record of what was changed, what was run, and what passed or
failed. This is the audit trail referenced by `CLEANUP-INVENTORY.md` and the
brief in `SPACE-BUNNY-INSTRUCTIONS.md`. Each phase has its own section.

Tests are scoped to the inventory baseline: `vitest run` over
`tests/unit tests/core tests/host tests/qualification tests/red-team` (518
files / 9496 tests, 6 to 10 pre-existing failures recorded in §1.3 of
`CLEANUP-INVENTORY.md`). The live, paid-model and Electron-E2E lanes are
**out of bounds** by owner instruction.

Commands are recorded as executed, with the worktree pinned at the start of
each section.

---

## Phase C0 — baseline inventory (commit `279049d`)

- Worktree: `C:\Users\you\Desktop\AI\.freya-worktrees\freya-cleanup`
- Branch / HEAD: `freya-cleanup` @ `4453563` (inventory at `279049d`).
- `git worktree list`: original `C:\Users\you\Desktop\AI\Freya` @ `34bd80f`
  on `feat/mind-missions-integration` — **not read, not written**.

Commands and results, in order:

| Step | Command | Result |
| --- | --- | --- |
| 1 | `npm ci` | FAIL — `ComSpec` empty in this shell, npm cannot spawn lifecycle scripts. Log: `C:\Users\you\AppData\Local\npm-cache\_logs\2026-10-10T01_04_59_754Z-debug-0.log` line 422 |
| 2 | `$env:ComSpec='C:\Windows\System32\cmd.exe'; npm ci` | OK — 341 packages, native binding built |
| 3 | `node node_modules/electron/install.js` | OK — electron binary present |
| 4 | `npm run typecheck` | PASS — three `tsc --noEmit` projects |
| 5 | `npm run lint` | FAIL — 16 pre-existing errors (itemised in `CLEANUP-INVENTORY.md` §1.2) |
| 6 | `npx vitest run tests/unit tests/core tests/host tests/qualification tests/red-team` (run A) | 9478 passed / 10 failed / 6 skipped (9496) |
| 7 | same (run B with json reporter) | 9482 passed / 8 failed / 6 skipped (9496) — flakiness recorded |

See `CLEANUP-INVENTORY.md` for the full evidence and the
KEEP / CONSOLIDATE / ARCHIVE-CANDIDATE / FIX matrix.

---

## Phase C1-A — secure default-deny for `localUnrestrictedMode` (commit `12cac4e`)

### Change

| File | Lines | What changed |
| --- | --- | --- |
| `electron/localUnrestricted.ts` | new (147 lines) | Pure decision function with closed-reason vocabulary |
| `electron/main.ts` | 207-217 → import + helper | `localUnrestrictedMode()` now delegates to `localUnrestrictedFromProcess(app.isPackaged).mode`; contract preserved |
| `electron/main.ts` | 73-91 | Startup diagnostic that names the reason when the env switch is set but the host stays strict |
| `tests/unit/electron/localUnrestricted.test.ts` | new (180 lines) | 22 targeted tests: packaged always strict, no opt-in = strict, near-miss strings refused, closed-reason vocabulary |
| `scripts/chat-acceptance-visible.mjs` | 155-157 | Stale "unpackaged defaults permissive" comment replaced with current reality |
| `scripts/desktop-shell-acceptance.mjs` | 77-78 | Added explicit-strict note (was already `=0`, now documented) |
| `scripts/smoke-app-capabilities.mjs` | 12 | Added explicit-strict note (was already `=0`, now documented) |
| `scripts/chat-onscreen-acceptance.mjs` | 314-321 | Added explicit `FREYA_LOCAL_UNRESTRICTED: '0'` (was relying on permissive default) |
| `scripts/chat-random.mjs` | 22-32 | Added explicit `FREYA_LOCAL_UNRESTRICTED: '0'` (was relying on permissive default) |
| `tests/e2e/desktop.e2e.ts` | 94-117 | Added explicit `FREYA_LOCAL_UNRESTRICTED: '0'` (was relying on permissive default) |

### New decision rule

1. **`app.isPackaged === true` → `mode = false`**, reason
   `packaged-build-always-strict`. Checked first. No environment variable
   re-opens a packaged build.
2. **`process.env.FREYA_LOCAL_UNRESTRICTED !== '1'` → `mode = false`**, reason
   `not-requested`. Exact match on the string `'1'`. `'0'`, `'true'`, `'yes'`,
   `'on'`, empty string and any whitespace-padded variant are all refused.
3. **`FREYA_DEV_USER_DATA` empty or unset → `mode = false`**, reason
   `no-separate-profile`. The profile must be a non-empty string.
4. **`--dev` not in `process.argv` → `mode = false`**, reason `not-dev-tagged`.
   This matches the precondition `electron/main.ts:577` already applies before
   it will move `userData`, so the two authorities can never disagree about
   whether this is a real profile.
5. All four hold → `mode = true`, reason `granted`.

### Verification at C1-A close

- `npm run typecheck`: PASS
- `npx vitest run tests/unit/electron tests/host`: 41 files / 428 tests passed
- `npx vitest run tests/unit tests/core tests/host tests/qualification tests/red-team`:
  9504 passed / 8 failed / 6 skipped (same 8 as the inventory baseline;
  +22 net from C1-A's new tests, +0 regressions)
- `npm run lint`: 16 pre-existing errors, +0 new

---

## Phase C1-B — gate `registerPhaseSixCapabilities` behind explicit opt-in (commit pending)

### Change

| File | Lines | What changed |
| --- | --- | --- |
| `core/index.ts` | 663-686 | New `CoreOptions.testCapabilities?: boolean` opt-in, default `false` |
| `core/index.ts` | 2378-2387 | `registerPhaseSixCapabilities(this.workRegistry)` gated on `this.options.testCapabilities === true` |
| `electron/coreHost.ts` | 599-611 | New `CoreHostOptions.testCapabilities?: boolean`, forwarded to `createCore` |
| `electron/main.ts` | 2040-2053 | Forwards `testCapabilities: true` to `coreHost` when `FREYA_E2E === '1'` so the e2e retains its fixtures without a production carve-out |
| `tests/core/work-test-capabilities.test.ts` | new | 4 targeted tests: default Core refuses `test.record`; opted-in Core registers; opt-in is `=== true` not truthy |
| 12 test fixtures | varies | `testCapabilities: true` added at every `createCore` call that previously relied on the unconditional registration, plus the `tests/host/coreHost.test.ts` and `tests/host/skillsBridge.test.ts` host fixtures and the two shared red-team / context-redteam harnesses |

### The opt-in contract

- `undefined` and `false`: no Phase 6 fixtures. This is the default for a
  shipped Core and for any production code path.
- `true`: Phase 6 fixtures are registered alongside whatever
  `options.workCapabilities` adds.
- Any other value (`'1'`, `'true'`, `'yes'`, `''`): treated as `false`. The
  gate is `=== true`, not truthy, so a typo cannot accidentally widen the
  surface.
- Never inferred from `NODE_ENV`, `VITEST`, `app.isPackaged`, a debug flag,
  or the presence of test runners. Production code sets neither; the e2e
  sets it through its own `FREYA_E2E` env switch; the test fixtures set it
  directly in their options objects.

### Verification at C1-B close

- `npm run typecheck`: PASS
- `npx vitest run tests/core/work-test-capabilities.test.ts`: 4/4 pass
- `npx vitest run tests/unit tests/core tests/host tests/qualification tests/red-team`:
  9508 passed / 8 failed / 6 skipped. Same 8 baseline failures; +4 from the
  new opt-in test file; **+0 regressions from removing the unconditional
  registration** (the 24 Skills / red-team / context-redteam failures that
  appeared mid-C1-B are all addressed by adding `testCapabilities: true` at
  the fixture sites, not by changing Core).
- `npm run lint`: 16 pre-existing errors, +0 new

---

## Phase C2-A — discriminate settled/failed/unknown in `lifeLoopVerify` (commit pending)

### Change

| File | Lines | What changed |
| --- | --- | --- |
| `core/lifeloop/ports.ts` | 98-130 | `LifeLoopVerificationOutcome` gains `outcome: 'settled' \| 'still-open' \| 'unknown'` and a docstring that names the closed vocabulary |
| `core/index.ts` | 4851-4956 | `lifeLoopVerify` rewritten to read mission and work projections directly, returning the closed `outcome` plus a `code` that carries the terminal status (e.g. `mission-completed`, `mission-failed`, `mission-cancelled`, `run-completed`) for journal readers |
| `core/index.ts` | 1722-1769 | Two test seams on the concrete `FreyaCore` class: `verifyReferenceForTest(reference)` and `verifyForTest(request)`, both unreachable from a renderer, both one-line wrappers around the same private methods the loop uses |
| `tests/core/lifeloop/harness.ts` | 146-154 | Default verify stub now returns the `outcome: 'settled'` field |
| `tests/core/lifeloop/runtime.test.ts` | 6 sites | Test stubs updated to include `outcome: 'still-open' as const` so the literal type narrows correctly |
| `tests/core/lifeloop-verify-classify.test.ts` | new (228 lines) | 7 targeted tests: unknown reference, empty string, open mission, settled mission, queued run, escalation-delivered with no decision, closed vocabulary |

### The three-state verdict

- `settled`: the reference is known to Core and is terminal. `holds: true`.
  The `code` field carries the terminal status so a journal reader can
  tell success from failure without leaving the verify port's record.
  The verify port does not adjudicate success; that is Core's mission
  projection's job.
- `still-open`: the reference is known to Core and not yet terminal.
  `holds: false`. The loop reads this as "retry".
- `unknown`: Core has no projection of the reference. `holds: false`.
  The old code returned `holds: true` for this case ("nothing is known
  to still be running"), which was the source of the false-success the
  brief is fixing: a missing reference is *unverifiable*, not verified,
  and treating it as settled burned a retry for no reason and hid the
  real bug.

### Verification at C2-A close

- `npm run typecheck`: PASS
- `npx vitest run tests/core/lifeloop-verify-classify.test.ts`: 7/7 pass
- `npx vitest run tests/unit tests/core tests/host tests/qualification tests/red-team`:
  9515 passed / 8 failed / 6 skipped. Same 8 baseline failures; +7 new
  from this phase; +0 regressions.
- `npm run lint`: 16 pre-existing errors, +0 new.

---

## Phase C2-B — authoritatively reconcile mission-linked assignments (pending)

## Phase C3 — docs, scripts, CI (pending)

## Phase C4 — bounded extractions (pending)

## Phase C5 — classify/retire legacy (pending)


