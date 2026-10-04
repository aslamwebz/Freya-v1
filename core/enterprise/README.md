# Phase 33 — Autonomous Enterprise / Webzone (self-contained domain slice)

**Status:** domain slice, green, **not wired into Core**.
**Branch:** `runtime/phase33-enterprise`
**Spec:** `PHASE-33.md` and `docs/phase33/*` (unchanged by this checkpoint — the spec is
the contract, this is the implementation of the part of it that can be built without
its predecessors).

---

## 1. Why this slice stops where it does

Phase 33 is downstream of **Phase 24** (Executive Intelligence), **Phase 31**
(Long-Horizon Autonomy) and **Phase 32** (Economic Intelligence). None of those is on
this branch or on `main` yet. So this slice contains **no import from any of them**,
and **no composition-root wiring**. Those are not omissions to be filled in later by
being clever; they are the boundary.

What is here is the part of Phase 33 that is genuinely self-contained:

| Delivered | Module |
|---|---|
| Compile-time contracts, closed vocabularies, frozen ceilings | `types.ts` |
| Owner-controlled business environments | `state.ts` (fold), `machine.ts` |
| Projects / products / services | `catalog.ts` |
| Customers (bounded, no money, no credentials) | `catalog.ts` |
| Bounded workflows | `orchestration.ts` |
| Enterprise boundaries + absolute deny list | `boundaries.ts` |
| Spending gates (hard ceilings, integer minor units) | `spending.ts` |
| Owner approvals (single-subject, revocable) | `approvals.ts` |
| External-action verification | `verification.ts` |
| Rollback / recovery | `rollback.ts` |
| Audit trail + explainable state | `state.ts`, `projection.ts` |
| Webzone-facing domain contracts | `types.ts`, `ports.ts`, `orchestration.ts` |
| Structural audits | `assertions.ts` |

## 2. What is deliberately *not* here, and why

Each of these is an **absence that is enforced**, not a gap:

- **No cognition port.** `EnterprisePorts` has no method that reaches a model. Phase 33
  cannot call one because it has no route to one — a stronger claim than "it chooses
  not to". `findCognitionEventsInVocabulary()` asserts no event type can even *record*
  a model call.
- **No authority port.** No capability check, no permission check, no grant. Phase 33
  does not decide what it is allowed to do; Core's Guard holds the capability.
- **No payment or spending port.** `WEBZONE_OPERATION_KINDS` is
  `publish | update | delete | query | interact`. An operation cannot be *described* as
  paying, ordering or signing, so the deny list never has to be the only thing stopping
  it.
- **No timer and no scheduler.** `runtime.ts` is driven by wakes Core already raises
  and by its own `open()` replay. `findTimerUsageInSource` scans for self-scheduling.
- **No durable store.** All state is derived from the journal; there is no second copy
  and nothing that a restart would not rebuild.
- **No UI.** Nothing here is reachable from a renderer.

## 3. How the central claim is made checkable

The claim is that Freya operating a business cannot widen its authority or spend real
money. Three mechanisms make it falsifiable rather than aspirational:

1. **The deciding code cannot act.** The pure modules below `./ports` have no clock, no
   network, no randomness and no port access. `findImpurityInSource` fails the build if
   one grows any of them.
2. **The deny list only moves one way.** `FORBIDDEN_ENTERPRISE_ACTIONS` is unioned with
   the owner's list; no input, event or payload removes an entry.
3. **No gate can be skipped by omission.** `authorizeEnterpriseAction` walks
   `AUTHORIZATION_GATES` with a loop and reports `evaluated` / `remaining`, so the
   ordering is demonstrated by execution in the test suite rather than asserted in a
   comment.

## 4. Integration, when the predecessors land

This slice integrates by filling `EnterprisePorts` and adding one line to a composition
root. The pieces it will need from Core, and nothing else:

| Port | Core provides |
|---|---|
| `append` / `replay` | `EventFabric` + `EventStore` |
| `stopAllActive` | the STOP ALL latch, read fresh |
| `performWebzoneEffect` | the existing bounded browser/relay capability, behind the Guard |
| `requestOwnerApproval` | the owner's approval path |
| `now` / `newId` | the host clock and id source |

### 4.1 Known gap: `allowedDomains` is not journaled

`enterprise.environment.boundaries-set` carries the four **numeric** ceilings only.
`allowedDomains` and `forbiddenActions` are lists, and the enterprise payload vocabulary
is deliberately flat scalars — a JSON array in a journal payload is a field whose
structure nothing validates, which is the same shape as the authority keys this phase
refuses everywhere else.

The omission is **fail-closed**: `runtime.ts`'s gate view requires a non-empty
`allowedDomains` before it will operate an environment at all, so an environment whose
allowlist is only in memory is one the gate declines. It does not fail *open*, which is
the direction that matters.

Resolving it needs one of: a bounded delimited-string encoding with its own validator, or
an extension to the enterprise payload vocabulary permitting validated arrays. Both are
integration-time decisions and neither is a reason to widen the payload shape now.

### 4.2 Integration tasks deliberately left undone

Both are additive:

1. **Journal registration.** `ENTERPRISE_EVENT_TYPES` and `ENTERPRISE_PAYLOAD_KEYS` are
   not yet in `core/events/envelope.ts` / `core/events/validate.ts`. Until they are,
   `EventStore` will reject these events as unknown types. The domain's own fold already
   validates them against the same table, and `tests/core/enterprise/runtime.test.ts`
   asserts every payload the runtime writes passes that check — so registering the
   vocabulary is mechanical and non-behavioural.
2. **Vault slice.** Structured business records belong in the canonical SQLCipher Vault
   per PLAN.md §4.1. Phase 33's state is event-sourced from the journal rather than
   duplicated into tables, which PLAN.md §4.2 explicitly permits for the event fabric —
   so this is consistent today, and no Vault migration is required by this checkpoint.
   Note that the numeric boundaries and spending ceilings *are* journaled (as
   `boundaries-set` / `spending-limits-set`) precisely so they survive a restart; the
   first version kept them in memory, which produced an environment with no ceilings at
   all after a restart.

Phase 24/31/32 integration (executive prioritisation, long-horizon continuation,
economic-intelligence hooks) is **not** anticipated here. When those land, the seam is
`orchestration.ts`'s pipeline, and the change should be additive.

## 5. Verification

```
npm run typecheck          # three projects
npm run lint
npm test                   # vitest, incl. tests/core/enterprise
npm run test:redteam       # tests/red-team/enterprise
```

All green at this checkpoint: typecheck (3 projects) clean, `eslint .` clean, **4789
tests passing** across 256 files, of which **552** are Phase 33 (394 domain + 158
red-team).

The domain tests are deterministic by construction: every instant in the harness is a
literal, every id is a counter, and the harness contains no provider, gateway or grant
store — **nothing in it can spend**, which is what makes "a wake does not imply a spend"
testable rather than merely claimed.

## 6. Defects this suite found in its own implementation

Recorded because they are the argument for having written the tests, and because a
reviewer should know they were caught rather than never present:

| Defect | Severity | Where |
|---|---|---|
| Fold validated the transition the payload *claimed* (`from`), not the record's real state — so a hand-edited entry could reopen a completed record | **High** | `state.ts` |
| An approval denied by the owner could be re-granted by a later journal entry | **High** | `state.ts` |
| `isForbiddenAction` returned `true` for any non-string, refusing every well-formed action at the boundary gate and masking every other boundary reason | **High** | `boundaries.ts` |
| Spending limits and numeric boundaries lived only in memory, so a restart produced an environment with no ceilings at all | **High** | `runtime.ts` |
| A customer or catalog item could be planted against an environment that did not exist | Medium | `state.ts` |
| A rollback could claim a reversal of an action the journal never recorded | Medium | `state.ts` |
| `evidenceIsAdmissible` folded "matched" into admissibility, making a well-evidenced *failure* indistinguishable from no evidence | Medium | `verification.ts` |
| `gate` on `action.refused` was validated against the *spending* gate vocabulary, silently discarding most refusals from the audit trail | Medium | `state.ts` |
| `analyseZeroHiddenSpend` correlated completions against the action namespace instead of the operation namespace, so "completed but never started" was undetectable | Medium | `assertions.ts` |
| Fold's numeric narrowing defect (`string \| null` computed key) across 14 sites | Low | `state.ts` |