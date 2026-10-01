# Phase 9 — Context: what "this" points at

The Context **foundation** ([#15](https://github.com/…/issues/15)) built the store:
a bounded, ephemeral, process-lifetime collection of things somebody shared, each with
provenance, a scope, a TTL and a revocation, and a pure resolver that answers whether
"this" or "here" points at exactly one of them.

It is a good store and it is unreachable. Nothing in Core constructs one. So this
document records what was built on top of it, and the more interesting question: **at a
boundary, what does a caller get to say?**

---

## What this phase is

At the end of it Core owns five operations — admit, revoke, revokeScope, resolve, read —
that a caller can reach, and none of them lets the caller decide where content came
from or how wide it is.

The interesting part is not the facade. It is that the foundation's rules were already
enough to stop the *wrong* forgery and structurally cannot stop the *right* one.

---

## 1. The forgery the foundation cannot refuse

`CONTEXT_KIND_SOURCES` in the foundation is a closed table pairing each context kind
with the sources it may come from. It refuses `owner_selection` claiming to be a
shared tab, and it refuses `core_record` claiming to be an explicit selection. Both are
good refusals.

Both are also refusals of **incoherent** claims. And the coherent case is the one an
attacker wants:

```
{ kind: 'explicit_selection', source: 'owner_selection', scope: session, content: '…' }
```

Every field is in a closed table. Every pair is legal. There is nothing for the store to
object to — because `ContextStore.admit` takes `source` **at face value**. The kind/source
table says "this pairing is meaningful", not "this caller is entitled to assert it".

So the provenance question has to be answered by something in front of the store, and
the answer is that **a caller never names its own provenance.** Three lanes, each fixing
the source itself:

| Lane | Source | Reachable from |
| --- | --- | --- |
| `admit(payload)` | derived from a closed owner-side `channel` | any payload |
| `admitHostReport(report)` | `host_report` | Core, from the host |
| `admitCoreRecord(record)` | `core_record` | Core, from its own records |

The second and third lanes' parameter types **have no `source` field and no `channel`
field**. `ContextHostReport` and `ContextCoreRecord` cannot express a claim about
provenance at all, so a host report cannot arrive dressed as the owner's own selection,
and a payload cannot reach either of them because `admit` has already refused every
source it might have claimed.

`admit` takes `unknown`. It is the parser, and it holds a closed field allowlist
(`ADMISSION_FIELDS`). A request carrying `source`, `principal`, `authority`,
`capability`, `permission`, `grant`, `onBehalfOf` or `trusted` is refused **whole** with
the offending names in the reason — the same reasoning as `WORKFORCE_NO_PAYLOAD`: a
field quietly dropped is a caller left believing its assertion landed somewhere.

---

## 2. Scope escalation, and the one scope worth forging

Scope is containment: `conversation` and `surface` are walls, not nestings, and
`session` is ambient — visible from every conversation and every surface. So `session` is
the only scope where putting content in is an *escalation* rather than a placement, and
it is the only one worth attacking.

**A payload can never aim at it.** `admit` refuses `scope_not_requestable` before the
registry is even consulted. Content reaches `session` through `admitCoreRecord`, which
only Core's own code holds — today, exactly one caller: the Mission adapter.

**A payload can only aim at a scope Core already holds.** Scopes live in a bounded
registry (`CONTEXT_MAX_SCOPES`, 16). Declaring happens on activation, because a caller
activates the scope it is actually in and a registry of scopes nobody is in is a registry
of scopes content could be aimed at from outside. A full registry **refuses rather than
evicts** — a forgotten conversation's scope losing its place to a newer one would silently
change what resolves.

The host lane is also barred from `session`. A host placing content where every
conversation and every surface can see it is how "one shared tab" becomes "a feed of
everything you have ever looked at", which is the omniscient global screen privilege
[D28](DECISIONS.md#d28--context-is-a-capability-not-omniscience) refuses.

---

## 3. The store is not a public field

`ContextIntegration.store` is an ECMAScript `#private` field, and it is the one `#` field
in the file.

A TypeScript `private` is erased at compile time. `integration['store']` would still
return the store at runtime, and a store whose `admit` takes `source` at face value is
a store that makes §1 optional. `#store` is not erased, so there is no expression that
reaches it, and "the store is unreachable" stops being a matter of everyone remembering.
Asserted as reachability in `context-core-boundary.test.ts`, not as an annotation.

---

## 4. Five refusals, five facts

The store's resolution refusals are already distinguished, and this layer preserves
them as **operation codes** rather than collapsing them into one failure:

| Operation | What actually happened |
| --- | --- |
| `unresolved-no-active-scope` | nothing is current, so there is nothing "here" can point at |
| `unresolved-no-candidates` | a scope is current and nothing in it matches |
| `unresolved-ambiguous` | more than one live item matches; naming one would be a guess |
| `unresolved-expired` | one item matched structurally and had outlived its TTL |
| `unresolved-revoked` | one item matched structurally and was taken back |

Reporting `revoked` when the truth was "two things match" teaches a person the wrong
thing about their own session. Reporting `ambiguous` when the truth was `revoked` invites
them to choose between two things that are not there.

Revocation has the same problem, and one instance of it was worth fixing here:

- `revoked` / `revoke-not-found` / `revoke-already-settled` are three facts, not one
  boolean. The store's `revoke` returns `false` for all three.
- **An already-expired item is refused rather than stamped.** The store's state rule puts
  revocation ahead of the clock, so revoking an expired item would convert a truthful
  `expired` into a `revoked` and erase the fact that the words had simply run out of
  time. That is a loss of accuracy bought with no gain — the content is already
  destroyed.
- **`scope-revoke-empty` counts live items, not settled ones.** The store's `revokeScope`
  counts everything not yet revoked, which includes expired items. Reporting those as
  revoked would put a number in front of a person saying work was done on content that
  had already been destroyed.

`unchanged` is its own operation too: an operation that admits nothing did not admit, and
a Mission board that re-renders must not churn context ids.

---

## 5. The read is metadata, and only metadata

`read()` returns `ContextAuditRecord`s and nothing else: ids, closed kinds and sources,
instants, states, and *measured lengths*. No content, no label, no URI, and not the
free-text reason for a revocation — that lives on a memory-only tombstone precisely so it
has nowhere shared to travel.

Two things are easy to miss and both are enforced:

**The counts are scope-filtered too.** A projection listing every retained record would
tell one conversation which ids, kinds and sources exist in *another*. That is a smaller
disclosure than content and a real one all the same, so `counts.retained` is the number
of rows this projection can account for — **not** the store's global total. A Core that
said "12 records" over here while listing two would have handed out a fact about somebody
else's conversation, and a bare count is enough to confirm one exists.

**No command returns content.** There is no `context.resolve` in the Core vocabulary.
`resolve()` returns an item and is reachable only from inside Core, because the answer to
"here" is consumed by the code that was about to act on it. `context.reference.read`
answers the same question with ids and the same five operations, which is all a window
can hold without turning a selected sentence into a value it can log and replay.

Still no `context.*` event family. The journal is audit surface — read, copied, exported
into backups, forwarded to whoever is debugging — and this layer appends nothing at all.
Asserted three ways: the event list is empty, no method on the facade can append, and the
facade takes no sink parameter.

---

## 6. The current-Mission adapter, and why it is this narrow

A Mission's **title, intent and success criteria** live in an encrypted Mission store
this lane has no business reading, and they are absent from `MissionRecord` on purpose:
the journal copy of a Mission holds ids, statuses, instants, counts and closed codes, and
that absence is what makes a Mission safe to keep in a backup.

So the adapter is built from what a `MissionSummaryView` already exposes in the open, and
there is no path from it to a Mission's words because the words are not on this side of
the boundary:

```ts
interface ContextMissionReport {
  missionId: string
  status: MissionStatus
}
```

That is the whole of what crosses. A wider adapter — one that read the title so "here"
could be "here: the offer letter" — would move the most private text Freya holds into an
ephemeral, process-lifetime store with no encryption, which is a downgrade dressed as a
feature.

Two more decisions, both load-bearing:

- **Session scope, and at most one live item.** A Mission is ambient by nature, and a
  Mission that only resolved inside the conversation it was created in would stop being
  "here" the moment the owner opened another surface. Two live items of one kind would make
  every "here" ambiguous, and ambiguous is a refusal — so re-pointing revokes the previous
  item rather than admitting alongside it.
- **The content is a function of the id and status, not the counters.** Counts move every
  time a Run is attached, and a "here" that re-points on every attachment would fill the
  audit with revocations of context whose meaning never changed — training a reader to
  ignore the one signal in it worth reading. Stale counts would be worse than none: a
  prompt compiler reading "2 of 5 runs" that was true four runs ago has been handed a fact
  it cannot check.

---

## 7. The agent seam is declared and unfilled

`ContextAgentSource` exists so #16 has somewhere to land, and **nothing calls it**.

`agent_work` is a deferred kind in the foundation, refused by name on admission for every
source. So even a filled seam could not admit an agent item today — there is no path from
a report to an item, because the kind is refused as soon as it is looked at. That is the
honest reason for declaring it unfilled rather than wiring it half-way: a half-wired agent
context would be an unsourced channel that *looked* sourced.

The seam is shaped like `WorkforceSource`: one required read, no mutable state, no method
that takes an instruction. `read()` reports `wired` and never `available`, so whoever
wires #16 can tell a filled seam from a gap — `true` and `unavailable` is a real, reachable
state and is not a bug.

The interface is a **proposal, not a commitment**. #16's actual shape is #16's to decide,
and the first thing that lands may well revise this.

---

## 8. What a window can reach

Five commands, and none of them is a resolve:

| Command | Payload it reads | Notes |
| --- | --- | --- |
| `context.status.read` | nothing | Projection arrives on the `onContext` mirror |
| `context.scope.activate` | `scope` | Declares if new, bounded; a missing scope is **refused**, not read as "clear" |
| `context.admit` | the whole payload | The facade is the parser; an allowlist only refuses what it recognises |
| `context.revoke` | `contextId`, `reason` | Three named outcomes |
| `context.revokeScope` | `scope`, `reason` | Live count, or `scope-revoke-empty` |
| `context.reference.read` | `term`, `kind` | Ids and the five refusals; never the item |

None of them is gated by Guard, and that is deliberate rather than an oversight. Guard
governs **authority** — what a principal may do — and context is not authority: admitting a
selection grants nothing and resolving "here" performs no action. Reading what the owner
shared, and choosing to share it, are the owner's own business, exactly as
`work.status.read` and `brain.status.read` are. That is only defensible while context stays
ungated, which is only true while it confers nothing — asserted by checking that no
`context.*` capability was added to the closed table.

A refusal sets `ok: false` **and** `refusal` on the envelope as well as the Context slot,
so a window that reads only the envelope cannot report a declined admission as a success.

---

## 9. Costs nothing

Idle context maintenance reaches no model and constructs no provider. Every operation is
synchronous, so a module with no `async` and no `Promise` has no continuation to resume on
a later tick with a request in hand — it cannot invent a way to spend money.

Constructed at boot and opening nothing: no key is read, no capture lane starts, no
inference is scheduled. There is no timer and no tick of its own; the instant comes from
Core's clock on every call, which is also what makes the same state and the same instant
produce the same verdict.

`tests/core/context/context-core-wiring.test.ts` asserts the provider call counter is
unchanged across a Mission created and activated, a scope activated, an admission, a
reference read, a projection read and a revocation.

Active-window capture lives outside this facade and outside this file: the observation lane
(`core/context/sources/window`, issue #30) is an explicit, opt-in, host-side reader of app and
window *identity*, and it reaches the store only through the facade's own host door
(`admitHostReport`), where the session scope is refused and the origin is mandatory. The
boundary itself still sees nothing — `active_window` asserted through an owner channel or
Core's record lane is refused by the provenance table, because a lane that bypassed the
boundary would be a lane that bypassed the point.

---

## 10. Where the tests are

| Claim | Test |
| --- | --- |
| The store holds, expires, revokes and refuses correctly | `tests/core/context/*.test.ts` (#15) |
| Forged provenance, scope escalation, the unreachable store, the unfilled seam | `tests/core/context/context-core-boundary.test.ts` |
| Five named refusals, named revocations, the scoped read, the Mission adapter | `tests/core/context/context-core-integration.test.ts` |
| No idle inference, no journal family, no content in any outcome, no authority | `tests/core/context/context-core-privacy.test.ts` |
| Core builds it, points "here" at the current Mission, answers the five commands | `tests/core/context/context-core-wiring.test.ts` |
| Opt-in observation, expiring window state, no-capture bounds, the host-door bridge | `tests/core/context/window/*.test.ts`, `tests/host/windowObservation.test.ts` (#30) |

`tests/core/context/context-privacy.test.ts` (#15) asserted that every file in
`core/context/` imports only its own directory. That assertion now names the five
foundation files explicitly, because the directory also holds the integration — and a
file that decides what a caller may claim has to know what a claim looks like. The
property still holds for the foundation, and there is a test that a sixth foundation file
would be a deliberate act rather than a silent escape from it.

---

## 11. Dependencies and deferrals

**Depends on #15**, and could not be built without it: `ContextStore`, the closed
kind/source table, the audit record shape, the refusal vocabulary and the two deferred
kinds. This is a stacked PR against `phase-9-context-foundation`.

**Deferred to #16** (active-agent context): `ContextAgentSource` is declared and unread.
Landing it needs three things, in this order — admit `agent_work` in the foundation, add
the one call that reads the source, and delete the "unfilled" paragraph from §7. Until
then the honest report is `wired: true, available: false`.

**Deferred to #18** (Electron/preload/renderer): the five commands exist in Core's
vocabulary and **no preload arm forwards them**, so a window reaching for them today finds
`unknown command`, which is the correct answer. #18 adds the bridge, the mirror wiring and
whatever surface shows "ambiguous" to a person. No Electron, preload or renderer file is
touched here.

**Deliberately absent**, stated plainly:

- **No capture inside this boundary.** The facade reads no screen, window, app or device;
  it is not where observation happens. `active_window` is admitted only through the
  facade's own host door (`admitHostReport`, no session scope, mandatory origin), fed by the
  separate opt-in observation lane (`core/context/sources/window`, issue #30) — identity
  metadata only, never pixels, and not wired into the desktop entrypoints by that lane.
- **No Workforce coupling.** No `WorkforceSource` is read, no worker or task is named, and
  the seam in §7 is a proposal rather than a dependency.
- **No encrypted context store.** `mode: 'ephemeral'`, `durable: false`, and the
  projection says why: no context store exists to encrypt, and a plaintext file of
  people's selections is exactly what the private-by-default rule exists to prevent. This
  is a deferred integration point, not an oversight.
- **No hands.** Nothing here acts on a resolved reference. Resolution tells code what "here"
  points at; what to do about it is a decision for a caller that already holds authority,
  and no caller that reaches a command can receive the answer.
- **Nothing for a worker principal.** `WORKER_CAPABILITIES` is untouched, and these
  commands carry no capability at all.