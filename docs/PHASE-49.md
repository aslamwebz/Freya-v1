# Phase 49 — Release / Evaluation / System Qualification

**Branch:** `runtime/phase49-release-evaluation` · **Base:** `f7d5436` · **Model:** `0.1.0`

---

## The claim this phase makes

> What this build can actually do is measurable, and what it cannot do is named.

Phase 40 already established that *implemented* is not *available*, and *available* is not
*active*, for a single Core at run time. That is the right answer to "what is running right
now". It is the wrong answer to a release question, which is a different question:

| the question | the answer |
| --- | --- |
| What is running in this Core right now? | Phase 40's runtime activation projection |
| What is running **in this build, on this machine**? | This phase |
| Is there **no** evidence here? | This phase, and it never becomes a pass |

The distinction is the whole thing. A gate that did not run, a gate whose tool is not
installed, and a gate that could not run because a foundation failed have all measured
nothing. This phase exists so that none of them can be reported as success — because that is
the single most common way a release document comes to describe a system that does not exist.

---

## What was built

### `core/qualification/` — the canonical layer

Seven modules, all pure except one, all inside the Core boundary (no `node:`, no Electron,
no React):

| module | what it holds |
| --- | --- |
| `types.ts` | The five readiness states, the six gate states, the closed evidence vocabulary, the two verdicts |
| `inventory.ts` | The capability inventory, derived from the canonical runtime registry; both a predicted form and a projection-driven form |
| `gates.ts` | The gate catalogue — 16 gates, each with one falsifiable sentence — plus the normalisation that stops an unevidenced `pass` |
| `scope.ts` | What the release declares it ships, and what it explicitly does not, with a reason per line |
| `verdict.ts` | The roll-up as a pure function of gate results plus inventory |
| `report.ts` | The Markdown report, rendered from the same object the JSON is |
| `live.ts` | Starts a **real** Core on a **real** directory so the report describes this build |

### `scripts/qualify.mjs` — the runner

Executes every declared gate as a real process, records the real exit code, reads the
capability inventory from a live Core's own projection, derives one verdict, and writes two
reports. It contains no gate logic that the test suite cannot reach — the TypeScript in
`core/qualification/` is the only thing that decides anything, and
`scripts/qualification-entry.mjs` bundles it with the esbuild already in this repository.

```
npm run qualify                 # every gate; writes release/release-qualification.{json,md}
npm run qualify -- --only=stop-all
npm run qualify:json            # canonical report to stdout
```

### The five readiness states

| state | meaning |
| --- | --- |
| `active` | Running under this Core in this build, every dependency met, nothing reduced |
| `available` | Every dependency met, nothing stopping it, **no handler wired — so it has not started** |
| `degraded` | Running, with at least one optional dependency absent, and the reason stated |
| `blocked` | Deliberately not running: a required dependency missing, declared fail-closed, or STOP ALL latched |
| `unavailable` | The implementation is not in this build, or the tooling is not installed |

`available` exists as its own state on purpose. It and `active` both mean "yes", and
collapsing them would hide the difference between "running under this Core right now" and
"everything it needs is present, and nothing has started it".

### The six gate states

`pass`, `fail`, `degraded`, `blocked`, `unavailable`, `not-run`.

Only `pass` clears a release. `blocked` means the gate could not run because a prerequisite
did not pass. `unavailable` means its tool is not installed. `not-run` means it was never
reached. **All three are non-passes**, and the roll-up treats them that way — see
`normaliseGateState`, which is the choke point that makes an unevidenced `pass` impossible
rather than merely discouraged.

---

## The gates

Sixteen. Nine are commands; seven are bounded cross-layer scenarios. All sixteen are
`required`, and `gates.test.ts` fails the build if any one of them is ever made optional.

### Command gates

| gate | proves |
| --- | --- |
| `typescript` | Every TypeScript project in this repository type-checks with no errors |
| `lint` | Every linted source file passes ESLint with no findings |
| `tests-unit-core` | The Core domain suites and the renderer unit suites pass |
| `tests-host` | The Electron host bridge suites pass |
| `tests-red-team` | Every adversarial suite passes |
| `build` | The renderer bundle and the unminified host artifacts build |
| `e2e-electron` | A real Electron process boots, drives and shuts down this build |
| `release-policy` | The lockfile is pinned and allowlisted, Core stays clear of Electron and React, every artifact is inside its budget |
| `extension-build` | The Manifest V3 extension type-checks, lints and bundles |

### Scenario gates — bounded cross-layer

Each crosses at least two layers, and each is bounded: a real temporary directory, no
network, no credential, a hard timeout.

| gate | layers crossed |
| --- | --- |
| `startup-shutdown` | `createCore` → `ElectronCoreHost` → runtime registry → release inventory |
| `persistence-recovery` | Core → JSONL on real disk → fresh Core → integrity surface |
| `stop-all` | Every registered domain at once + Device Hands adapters + a real restart |
| `provider-lifecycle-security` | Endpoint policy → provider → gateway → the whole data directory on disk |
| `runtime-activation-truth` | Live Core projection ↔ release inventory ↔ shipping scope ↔ gate catalogue |
| `device-hands` | Phase 42 activation → Core's ten-gate pipeline → real bounded adapters → journal replay |
| `browser-extension` | Phase 43 bridge → pairing → session → dispatch → Device Hands |

---

## Findings

These are what the qualification layer found. They are the reason it exists.

### 1. `release:check` was failing on a stale number, not on growth

```
- mainBytes exceeds budget: 2103029 > 2100000
```

Phase 43 merged the browser-extension bridge into the main process — `bridgeServer.ts`,
`browserAdapter.ts`, `wsFrames.ts`, `crypto.ts` — without moving the Phase 42 ceiling. The
bound was tracking a bundle that no longer existed, so the gate was reporting failure
against a measurement nobody had made.

**Dispositioned, not waived.** The ceiling is raised to `2_200_000` with the Phase 43 growth
written into the comment, which is the same practice the two earlier revisions used.
Measured after the change: **2,103,043 bytes**, about 4.6% under the new bound. The host
stays unminified on purpose so its security-critical source can be audited in the shipped
artifact — which is the only reason the number is worth tracking.

### 2. The journal is not authenticated — **unresolved blocker**

The JSONL journal validates *structure*: sequence, schema version, event id, ordering. It
refuses a record that fails those, reports `corrupt` with the offending line, and comes up
`degraded` rather than `ready`. A truncated tail is reported as `torn` with the byte count.

It does **not** sign or hash a payload. A payload edited in place while its envelope is left
intact reads back as-is, with `integrity: 'ok'`.

Phase 49 reports this rather than writing a test that implies a protection the code does not
have. The limitation is pinned with `it.fails` in
`tests/qualification/scenarios/persistence-recovery.test.ts`, so the day the journal gains
payload authentication that test **fails on purpose** — which is the signal that this
document has stopped being true.

### 3. `control.request` widens the extension session past the host's capability list — **unresolved blocker**

`setControl` replaces a session's capabilities with `BROWSER_BRIDGE_OBSERVATION_CAPABILITIES`
plus the **entire** `BROWSER_BRIDGE_CONTROL_CAPABILITIES`, discarding what
`capabilitiesFor(extensionId)` returned. A host that deliberately withheld `element.click`
still has it routed once the owner grants control.

This is not a full bypass. Every control command still arrives carrying a Device Hands
`actionKey`, so the Phase 35 grant gate remains downstream and still holds. What is lost is a
layer of defence in depth — and a per-extension capability list that a host sets believing it
is narrowing. The host would have to grant the control capability broadly to be affected in
practice, which is the current production wiring.

Also pinned with `it.fails` in
`tests/qualification/scenarios/browser-extension.test.ts`.

### 4. The gate caught a real error in this very phase — and cascaded honestly

An intermediate run of `npm run qualify` returned **`no-ship`**: the `typescript` gate exited
2 and the `lint` gate exited 1, because the new `tests/qualification/ci-enforcement.test.ts`
imported `RELEASE_GATES` and never used it. `vitest` does not type-check or lint, so every
per-suite command I had run reported green while `npm run typecheck` would not have.

What matters more than the typo is what the layer did with it. Thirteen downstream gates were
recorded as `blocked` with the prerequisite named, not skipped, and the verdict was
`no-ship`. Had the layer treated "the foundation failed" as "skip the rest", the run would
have produced thirteen more green lines over a build that did not type-check.

### 5. Two Device Hands actions are blocked and stay blocked

`browser.click` and `browser.type-text` need a live, scriptable page. This host owns a
script-free, read-only document on purpose; making it scriptable would hand a background
runtime the ability to run a page's code. Both are refused with the reason attached and
listed in the activation status, rather than quietly dropped from the vocabulary. Both are
in `DEVICE_HANDS_BLOCKED_ACTIONS` and both are asserted by the `device-hands` gate.

---

## Verified readiness of this build

Measured from a live Core started on a real directory by `scripts/qualify.mjs`, with **no**
key, no Vault, no provider credential and no host seam. That is the floor, and a capability
that claims `active` at that floor is claiming more than the evidence supports.

**13 active · 6 degraded · 3 available · 7 blocked · 0 unavailable**

| readiness | capabilities |
| --- | --- |
| `active` | `core.security-spine`, `core.missions`, `core.work`, `core.context`, `core.workforce`, `core.attention`, `core.office`, `core.skills`, `core.world`, `core.life`, `core.consciousness`, `core.lifeloop`, `core.foundry` |
| `degraded` | `core.vault` (no open Vault), `core.conversation`, `core.brain`, `core.personality` (no keyring entry), `core.relay` (no connector), `core.voice` (no local speech engine) |
| `available` | `core.sovereignty`, `core.evolution`, `core.threshold` — dependencies met, **no activation handler wired**, so not running |
| `blocked` | `core.long-horizon` (continuation not wired), `core.economic` (fail-closed), `core.enterprise` (fail-closed), `core.multidevice` (no transport, no trusted device), `core.device-hands` (no capability grant), `core.resilience` (recovery seam unmet), `core.browserext` (fail-closed) |
| `unavailable` | none — every registry implementation is physically present in this tree |

The six `degraded` capabilities are the honest reading of a build with no keys: they run, and
they say out loud what they cannot do. `core.voice` degraded means there is no cloud speech
engine implied; `core.relay` degraded means a connector-less relay is running, not absent.

**The three `available` capabilities are the important row.** `core.sovereignty`,
`core.evolution` and `core.threshold` have every dependency satisfied and no handler. They
are implemented, dependency-checked, and not running. Reporting them as `active` would be
the exact lie this phase exists to prevent.

---

## Exact test results

Baseline at `f7d5436`, and after this phase:

| suite | baseline | after | gate |
| --- | --- | --- | --- |
| TypeScript (4 projects) | pass | pass | `typescript` |
| ESLint (`eslint .`) | pass | pass | `lint` |
| Unit + Core (`tests/unit`, `tests/core`) | — | **281 files, 5915 tests, all pass** | `tests-unit-core` |
| Host / integration (`tests/host`) | — | **25 files, 287 tests, all pass** | `tests-host` |
| Red team (`tests/red-team`) | **69 files, 1231 tests, all pass** | **69 files, 1231 tests, all pass** | `tests-red-team` |
| Whole suite (`npm test`) | 375 files, 7433 tests, all pass | **386 files, 7571 tests: 7569 pass + 2 expected-fail** | — |
| Phase 49 qualification suite | — | **12 files, 144 tests: 142 pass + 2 expected-fail** | — |
| Electron E2E | 216/216 pass | **216/216 pass** | `e2e-electron` |
| Build (renderer + host) | pass | pass | `build` |
| Extension artifact (`extension:verify`) | pass | pass | `extension-build` |
| `release:check` | **FAIL** — stale `mainBytes` budget | **pass** | `release-policy` |

The whole-suite total grew from 375 files / 7433 tests to 386 files / 7571 tests: +11 files
and +138 tests, all of it new qualification and scenario coverage. The red-team total is
unchanged at 1231 tests, which is the point — nothing here weakened an existing gate.

The two `expected fail` results are the pinned limitations from findings 2 and 3. They are
`it.fails`, not skipped: they execute, and they would fail the gate if the limitation were
fixed.

`npm run qualify`, all sixteen gates: **16 pass, 0 fail, 0 blocked, 0 unavailable,
0 not-run.**

---

## Verdict

# ship

**Every required gate executed in this run and proved its claim, and every capability the
release declared shipping is genuinely running.**

The verdict is not "everything is perfect". It is the narrower and more useful statement
that *nothing is being claimed that was not measured*, that two specific limitations are
named and pinned rather than buried, and that the eleven capabilities this release does not
ship are listed with the reason each one is off.

### Unresolved blockers

Neither of these blocks this verdict, and both need a decision rather than a fix:

1. **The event journal has no payload authentication.** Structural corruption is detected
   and reported; an in-place payload edit is not. Anyone treating the journal as
   tamper-evident is mistaken about it. Fix: sign or hash payloads and verify on replay.
2. **`control.request` discards the host's per-extension capability list** and substitutes
   the full control vocabulary. The Device Hands grant gate still holds downstream, so this
   is defence-in-depth rather than a bypass — but a host cannot currently narrow an
   extension to a subset of control capabilities. Fix: intersect the granted set with
   `capabilitiesFor` rather than replacing it.

### Not shipped, and not claimed

`core.long-horizon`, `core.economic`, `core.enterprise`, `core.multidevice`,
`core.device-hands`, `core.resilience`, `core.sovereignty`, `core.evolution`,
`core.threshold`, `core.browserext`.

Each is declared `not-shipping` with a reason in `core/qualification/scope.ts`, inventoried
in the report with its live readiness, and forbidden from contributing to the verdict. The
last one deserves its own note: the **Phase 42 and Phase 43 host seams are genuinely wired
and genuinely qualified** — the `device-hands` and `browser-extension` gates both pass with
real bounded adapters — while the *runtime registry entries* stay `blocked`/`fail-closed`,
because a real capability grant is the owner's to create at run time. The report says both
things rather than collapsing them.

---

## What would have to change for this gate to be untrustworthy

Stated so the next reviewer knows where to push:

- **`normaliseGateState` deleted or bypassed.** Every `pass` would become a string anybody
  could write. `verdict.test.ts` makes eleven separate attempts to obtain a `ship` without
  earning one — one per non-pass gate state, a gate missing from the results entirely, a
  `pass` with no process behind it, a `pass` whose process failed, a shipping capability
  that is not running, one missing from the build, and one with no claim at all — and
  requires every one of them to come back `no-ship`.
- **The inventory re-derived instead of read.** `buildInventoryFromProjection` reads the
  controller's own status and evidence rather than recomputing them, precisely so a report
  cannot describe a second, more flattering runtime. `agreement.test.ts` runs the predicted
  derivation and the real `RuntimeActivationController` across 13 fact sets × 4 handler
  wirings × 29 domains and requires them to agree on every one.
- **The shipping scope left incomplete.** The check runs both ways: a capability present in
  the inventory with no claim is a gap, and a declared capability *absent from the
  inventory* is also a gap — a declared capability the measurement cannot see is not a
  capability that shipped.
- **A scenario gate's suite deleted.** `gates.test.ts` stats the file every scenario gate
  names, so a deleted suite stops being a gate rather than quietly becoming a green line.

## Commits

```
488401a docs(phase-49): the release qualification report
ca74cfc ci(phase49): run the qualification, and correct the stale host artifact budget
c50839f test(phase49): bounded cross-layer scenarios, and proof the gates cannot flatter
c023bb5 feat(phase49): the gate runner, and sixteen release gates
084f2ba feat(phase49): the canonical release qualification layer
```

Base `f7d5436`. Branch `runtime/phase49-release-evaluation` only; Main, UI Alpha and
phases 45–48 and 51 untouched.