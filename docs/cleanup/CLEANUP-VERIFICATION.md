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

## Phase C1-A — secure default-deny for `localUnrestrictedMode` (in progress)

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

### Verification (this section, end-of-phase target)

Recorded in `CLEANUP-VERIFICATION.md` once the C1-A commit is in.

---

## Phase C1-B — gate `registerPhaseSixCapabilities` behind explicit opt-in (pending)

## Phase C2-A — discriminate settled/failed/unknown in `lifeLoopVerify` (pending)

## Phase C2-B — authoritatively reconcile mission-linked assignments (pending)

## Phase C3 — docs, scripts, CI (pending)

## Phase C4 — bounded extractions (pending)

## Phase C5 — classify/retire legacy (pending)
