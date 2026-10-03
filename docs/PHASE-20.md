# Phase 20 — Unified Conscious Context

> ## STATUS: integration preparation. NOT final Phase 20.
>
> This lane is rebased onto merged Phase 21 and Phase 22 before anyone calls it
> done, and it must not be described as complete until that has happened.
>
> `PLAN.md` §6 requires this projection to consume authoritative projections from
> **Phase 21 (Life)** and **Phase 22 (Self/World)**. Neither exists on this
> baseline. So:
>
> - `life` is a **stated absence** — `state: 'absent'`, a note naming Phase 21, a
>   `provenance` row, and a health line that says the snapshot is incomplete
>   *because* `life` is missing. Never zeroed, never simulated.
> - `self`, `world` and `continuity` are read through narrow **input ports**
>   (`core/consciousness/ports.ts`). The Brain is today's authority behind them;
>   Phase 22 takes them over by writing its own adapter.
> - No Phase 21/22 domain shape has been invented. The ports are a consumer-side
>   contract, and the exact seam each phase must satisfy is in
>   [Integration points](#integration-points-phase-21-and-phase-22) below.
>
> Everything else in this document is the contract as it was written and as it now
> stands. The derivation, the privacy boundary, the read-only structure and the
> determinism guarantees are all live and tested here; the *completeness* claim is
> not, and the snapshot says so on every read rather than in a comment.

Freya has a dozen contributing sources that each answer a question about her own situation, and every surface that wants to know "what is going on" has been assembling an answer out of whichever two or three of those mirrors it happened to be holding. The Office draws the floor. The board draws Work. A status chip draws `CoreStatus`. Nobody is holding the whole picture, so nobody is *checking* whether the pieces agree.

The Unified Conscious Context is one object: a bounded, typed, read-only projection of what Freya currently understands about herself and her situation, derived from the authoritative state the other subsystems already hold. A future surface reads it once and observes the same mind, instead of reconstructing a dozen sources and getting a different answer each time.

It is not a summary written for a person. It is a projection, in the same sense as every other projection in Core: a pure function of state that already exists, with no storage of its own.

## What this phase is not

It is not a thirteenth subsystem with its own events, and it introduces no durable state. Everything in the snapshot is derivable from what the journal already records and from the volatile detail the engines already hold, so there is nothing here that a restart could lose and nothing here that replay could disagree about.

It is not Phase 21. There is no autobiographical narrative, no consolidated self-model, no memory of episodes assembled into a life story. The continuity section is a bounded listing of what has been admitted recently and how much Core trusts it — metadata, not prose about a life.

It is not a new source of authority. STOP ALL, approval, privacy and capability boundaries are unchanged, and this phase adds no method that a renderer can call to move any of them.

## Core ownership

`core/consciousness/` is Electron-free and renderer-free, like every domain.

| File | Owns |
|---|---|
| `core/consciousness/types.ts` | The internal vocabulary: the limits, the closed source set, the freshness ranking and the total orders every list is sorted by. |
| `core/consciousness/ports.ts` | The narrow input contracts for the domains `PLAN.md` §6 requires but which have not landed. Consumer-side only; no producer's shape is declared here. |
| `core/consciousness/adapters/brain.ts` | Today's producer for the `self`, `world` and `continuity` ports, and the single place a memory `subject` is reduced to a length. |
| `core/consciousness/projection.ts` | `projectConsciousContext` — the whole derivation, as one pure function. Every omission decision is made here and nowhere else. |
| `core/consciousness/index.ts` | The barrel. |

`core/protocol/consciousness.ts` is the **window-facing view**: the shapes a renderer is typed against, the frozen snapshot for a Core that has no conscious context, and the schema version. It carries no function that writes.

There is no engine, no store, no `CoreState` slice, no Vault table, no key, no
cache, no `consciousness.*` event type and no `CoreCommandName` member. That
absence is asserted against source in
`tests/core/consciousness/phaseDependency.test.ts` — an absence cannot be
demonstrated by exercising the code that is supposed to lack it. A snapshot is recomputed from live projections whenever a listener is attached and whenever any contributing subsystem changes, which is why it cannot drift from the state it describes.

## The derivation

One pure function, and it takes everything it reads as an argument:

```
projectConsciousContext(input: ConsciousInput, now: Date): ConsciousContextProjection
```

`ConsciousInput` is the set of projections Core already builds — `core`, `brain`, `work`, `mission`, `workforce`, `skills`, `personality`, `attention`, `context`, `office`, `relay`, `activity` — plus the three things that live in `CoreState` and nowhere else (`stopAll`, `faults`, `pendingRequests`) and the Office's folded presence requests.

Four members are **not** subsystem projections. `self`, `world`, `continuity` and
`life` are narrow readings declared in `ports.ts`, because two of the four
contributors `PLAN.md` §6 names do not exist yet. See
[Integration points](#integration-points-phase-21-and-phase-22).

`now` is an argument rather than a read, for the reason every other derivation in Core takes one: the same durable state and the same instant produce the same snapshot, so replay and restart reproduce it exactly.

**Nothing is duplicated.** There is no `consciousness.*` journal event and no second copy of a mission status. If a mission status moves, the snapshot moves, because the snapshot is a function of the mission projection.

## The snapshot

| Section | Answered | Basis |
|---|---|---|
| `stopAll` | Whether Freya has been told to stop, and by whom | authoritative |
| `self` | Name, role, purpose, claimed capabilities and stated limitations | authoritative |
| `posture` | Current relationship posture: continuity, formality, temperament, counts | derived |
| `focus` | What she is on: attention focus, live runs, active missions, working agents, current scope | derived |
| `attention` | What arrived, what Core decided, what is cued, what is scheduled | authoritative |
| `waiting` | Approvals, blocked workers, blocked tasks, waiting runs — ids and states only | authoritative |
| `agents` | Workers, their status, their delegated work, their budgets and limits | authoritative |
| `practice` | Procedures, their lifecycle, their evidence counts, and the thresholds Core will not bend | authoritative |
| `world` | Entity, relation and observation counts, plus live contradictions | authoritative |
| `life` | What happened in Freya's life — counts and bounded entry metadata. **Absent on this baseline**; Phase 21 supplies it | authoritative |
| `continuity` | Recently admitted memories, by kind, source, confidence and instant | authoritative |
| `recentChanges` | The last few durable events, as a closed kind plus its sequence and tone | authoritative |
| `uncertainty` | What Core does not currently know, as closed codes | derived |
| `nextActions` | The actions Core's own projections already offer | derived |
| `provenance` | Per-source basis, freshness, sequence and note | derived |
| `limits` | The ceilings this snapshot was built under | authoritative |

Every section carries the same three fields:

- `state` — `'available' | 'absent' | 'degraded'`.
- `note` — why, in one sentence, when it is not `'available'`.

## Provenance and freshness

Two sets, both closed, both stated rather than implied.

**`basis`** — where the value came from.

- `'authoritative'` — lifted from state another subsystem owns and can be held to.
- `'derived'` — computed here, from authoritative state, by a rule that is in this repository and is testable.

Anything this phase computes — `posture`, `focus`, `uncertainty`, `nextActions`, `provenance` — is `'derived'`, and says so. A consumer never has to guess whether it is being told a fact or being told an inference.

**`freshness`** — how much to trust it right now.

- `'fresh'` — the source is healthy and whatever it reports is current.
- `'stale'` — the source is present but has lost the volatile half of its detail. Work and Workforce go here after a restart (`detailAvailable: false`), and Brain, Personality, Context and Missions go here when their store is not durable. A surface can then say "I know this but only from before the last restart" instead of rendering an empty list as though nothing had ever been there.
- `'absent'` — the source is not present in this build. Never an empty list, which would read as "there is nothing".
- `'unknown'` — the source is present but could not be read. A degraded Brain is `'unknown'`, not `'absent'`: the difference between "Freya cannot remember" and "we cannot ask her" matters to a person reading it.

`'absent'` and `'unknown'` are deliberately different values all the way down to
the section's own `state`, and this was a bug found by test rather than by review:
an early draft reported both as `absent`, which is precisely the conflation the
distinction exists to prevent. Two smaller rules fall out of the same finding:

- The snapshot's own `freshness` is the **weakest** reading across its sources,
  never a summary and never the best one. Reducing it the wrong way round yields
  a confidently incomplete picture that reads as correct.
- "Nothing is uncertain", "nothing changed" and "nothing is next" are claims about
  a Core that is **up**. Before Core starts those sections are `absent`, because
  an empty list asserting completeness is the one rendering this phase forbids.

## The absence, and why it is not an empty snapshot

A Core that has not started, or a build with no contributing subsystem, gets the frozen `ABSENT_CONSCIOUS_CONTEXT_PROJECTION`: `health: 'unavailable'`, every section `state: 'absent'`, every list empty, every count zero, and `reason` naming what is missing.

This is the same rule Phase 4's absent Attention projection follows and for the same reason. A surface that cannot tell "nothing is happening" from "nothing is watching" will eventually tell a person they are caught up when Freya is not listening at all. Zero counts are not the honest answer to an absent subsystem; a stated absence is.

A Core that *is* running but is missing subsystems answers `health: 'degraded'` with each absent section named individually — so "I know who I am but I have no Workforce" is a readable fact rather than an absence of one.

## What never crosses

The shape of the read is the whole policy, as everywhere else in Core. Concretely, these exist elsewhere in Freya and have **no field** on this projection:

- Memory `content`, and the `subject` of a memory record — replaced by `subjectLength`, a measurement.
- Mission `title`, `intent` and `successCriteria` — reachable only through `missionDetail`, for the owner.
- Context item `content`, `label` and `uri`.
- Relationship item `text`, `tags` and `admissionReason`.
- Attention event `text`.
- Workforce message `body`.
- Work approval `justification`, `proposal` and `reason`.
- Run and task labels, and task `title`.
- Relay connector payloads of every kind, including read results.
- Any connector payload, credential, token, secret reference, raw prompt, model request or response.
- `CoreActivityEvent.text`.

That last one is a deliberate loss. The activity sentence is Core-authored and already crosses to every renderer today, so keeping it would leak nothing new — but a snapshot whose every field is an id, a closed code, a measurement or an instant is an invariant that can be checked exhaustively, and "the snapshot has no free-text channel" is a much stronger thing to be able to say than "the free-text channel was reviewed".

`self` is the one section carrying sentences, and they are `FREYA_IDENTITY` and
`buildSelfDefinition()`'s own fixed statements — Core's account of itself, seeded
by Core, immutable in the Brain, and already projected verbatim by `brain()`. When
Phase 22 takes the `self` port over, that remains the rule its adapter must
preserve: prose is allowed here only because it is Freya's own account of herself,
and a producer that began accepting the owner's wording would break an invariant no
type can express. The leakage sweep is the backstop.

### The test applied to each field, stated so the omissions are auditable

A reader will notice an asymmetry here and should be able to check it: a Mission's
*title* is excluded while a worker's *name* and a skill's *slug* are included. That
is deliberate, and the rule behind it is narrow enough to state:

> A field is excluded if the subsystem that owns it deliberately keeps it out of
> its own standing projection, and included if that subsystem already projects it
> verbatim.

Mission titles live in `MissionContent`, in an encrypted store, reachable only
through `missionDetail` for the owner — Phase 7 deliberately keeps them off the
board, so they are off the snapshot too. A worker name and a skill slug are already
in `workforce()` and `skills()`, Core-normalised and length-bounded at admission.

So the honest limit of this guarantee is: **Core cannot know whether a label the
owner chose to give Core is sensitive.** Someone who names a worker after their
password has put it in a field Core already projects to every window, and this
projection neither improves nor worsens that. What it guarantees is that nothing
reaches the snapshot that has not already crossed as part of being a fact about
Freya's state.

## Stop All

STOP ALL is the first section, above everything else, and it is authoritative.

When it is active, `nextActions` is **empty**. Those actions are derivations of what Core's Mission and Workforce projections already advertise, and advertising them while the owner has said stop would be a snapshot that describes an intention Freya is not permitted to have. A red-team test asserts it.

The snapshot stays readable under STOP ALL, because reading is not acting and a person asking "what does it know" during an incident is exactly the person who needs the answer.

## Approval

`waiting.approvals` carries `approvalId`, `runId`, `capability`, `requiredCapability`, `risk`, `status` and `requestedAt` — enough to know what is being asked for and how risky it is, and nothing about what the action would do. `justification` and `proposal` are the two fields that would answer the question properly, and they are exactly the two that are excluded: this projection is not the place an approval gets decided.

There is no command that approves, denies or expires anything, so there is no path from this surface to a decision.

## Determinism, bounds and restart

- **Pure.** `projectConsciousContext` reads no clock, no randomness and no module state. Same input, same output.
- **Totally ordered.** Every list is sorted by a key that cannot tie — a durable sequence, else an instant, else an id — so two runs over the same state produce byte-identical arrays.
- **Bounded.** `CONSCIOUS_CONTEXT_LIMITS` fixes every list, and `provenance` publishes the limits it was built under. Nothing grows with history.
- **Replay-safe.** There is no new durable state to replay. Re-fold the same log, call the function with the same `now`, and the snapshot is identical.
- **Restart-safe.** A restart re-derives the snapshot from the re-folded log plus whatever volatile detail the new process holds. Sections that lost their volatile half report `'stale'` and say which ones, rather than silently shrinking.

### What "restart reproduces the same projection" does and does not claim

Worth being exact, because the loose version of the claim is false and a test
that asserted it would be asserting something untrue.

A Core **appends its own lifecycle events** on start and stop. So a restart
genuinely changes the durable record, and two snapshots either side of one are
*not* byte-identical: `provenance.durableSequence` and the tail of
`recentChanges` legitimately advance.

What is reproduced exactly is everything derived from the durable record:
`stopAll`, `self`, `posture`, `world`, the offered actions, and the durable shape
of `uncertainty`. The one row deliberately excluded from the replay comparison is
`cognition.governor-closed`'s `since`, because it is a *session* fact — "closed
since this process started" — and asking a session fact to survive a restart
would be asking it to be durable.

`now` is a parameter of `core.consciousness(now?)`, for the same reason
`attentionTick` takes one: holding the instant still is what makes "the same
durable state gives the same snapshot" a statement a test can check at all.

## Read-only, structurally

- No `CoreCommandName` member. There is no `consciousness.status.read`, and there is no reason to add one — a pull channel and a push channel are both enough for a read.
- `Core.consciousness()` and `Core.onConsciousness(listener)` are the only two methods, mirroring every other domain's pair.
- The host adds `consciousness()` and `onConsciousness()` and nothing else, following the existing `null`-before-Core rule: silence, not a sentinel.
- The preload exposes `coreConsciousness()` and `onCoreConsciousness()` and **no command**. A host test reads the preload source and asserts the word does not appear in the `CORE_COMMANDS` set.
- The main process registers one `freya:core:consciousness` handler, `ipcMain.handle`, and there is no `ipcMain.on` for it.

## Renderer

Nothing renders this yet, and nothing was added to make something render it. The bridge exists so a Phase 19 surface can consume one object instead of eleven, when it is ready to.

## Independence, and the reconciliation with Phase 17

Phase 20 has no dependency on Phase 18 packaging, and Phase 18 has none on it.

Phase 17's Skills is a different matter, because it is already integrated on `main`. Skills was **not** treated as unfinished and deferred — a conscious-context projection that omitted Freya's own procedures would answer "what does she understand about herself" with a gap in the middle of it, and an unverified procedure and a promoted one are very different things to have available. So `practice` is a first-class section, read-only and metadata-only, and `skills` is a row in `provenance`.

What that reconciliation is *not* is a dependency on Skills' internals. The snapshot reads `SkillProjection` — the same view a window already receives — and nothing beneath it. If Skills later replaces its engine, store or promotion tables, this projection sees a new projection behind the same name and needs no edit.

The general rule the reconciliation demonstrates: **a subsystem added to Core becomes another row in `provenance` and at most another section, never another field on an existing one.** That is why `sources` is a list over a closed set rather than eleven fixed fields.

## Integration points: Phase 21 and Phase 22

This is the section to read when picking up either of those phases. Nothing else in
this lane has to change when they land; the four steps below are the whole handoff.

### Why ports rather than imported domain types

There is no `core/life/`, `core/self/` or `core/world/` on this baseline, so there
is no domain type to import. The two available wrong answers:

1. **Write a plausible `Phase21LifeProjection` here.** That is an invented domain
   shape, and Phase 21 would then have to conform to a contract written before it
   existed — which is how incompatible models get frozen in.
2. **Omit the domains until they land.** Then the projection compiles, looks
   finished, and silently skips a domain `PLAN.md` names as required. A snapshot
   that is quietly incomplete is the exact failure this phase exists to prevent.

A port is the third answer: a **consumer-side** contract declaring the smallest set
of readings this projection can use, with no claim about how the producer stores or
models them.

### Step 1 — Phase 21 supplies `life`

Phase 21 adds `core/consciousness/adapters/life.ts`:

```ts
export function lifeFrom<Phase21Projection>(p: Phase21Projection): ConsciousLifeReading | null
```

It maps Phase 21's Life projection onto `ConsciousLifeReading`, then one line in
`FreyaCore.consciousness()` changes `life: null` to `life: lifeFrom(this.life())`.
Nothing in `projection.ts`, `ports.ts` or the protocol changes.

The adapter is where Phase 21's privacy boundary is enforced. If Phase 21's
standing projection carries narrative text, the adapter must reduce it to
`textLength` — `ConsciousLifeEntryReading` has no field for prose, so a text field
will not compile, and the leakage sweep proves the reduction happened.

The moment that lands, `life` stops being a reason for `health: 'degraded'`. A
test already exercises this path with a synthetic reading
(`tests/core/consciousness/phaseDependency.test.ts`).

### Step 2 — Phase 22 takes over `self` and `world`

Phase 22 adds `core/consciousness/adapters/self.ts` and `world.ts`, producing
`ConsciousSelfReading` and `ConsciousWorldReading`. The three `*FromBrain` calls in
`FreyaCore.consciousness()` are replaced. The projection does not change.

**One producer per port, chosen in Core and nowhere else.** Precedence is *not*
implemented as a merge, a fallback chain or a "prefer whichever is non-null" inside
an adapter — each of those would let two subsystems both believe they own the
answer. `FreyaCore.consciousness()` picks exactly one producer per port.

Two consequences Phase 22 should decide deliberately, not discover:

- `brain` is still read directly, for the one thing only it can answer: whether the
  Brain itself is readable. That is a `provenance` fact, not a section, and it
  stays.
- `ConsciousContinuityItemReading` reuses the Brain's own closed unions
  (`MemoryKind`, `SourceTrust`, `Confidence`, `MemoryStatus`) rather than a
  Phase-20-owned `string`. The crossing view declares the same unions, so widening
  the port could only ever fail to compile later. If a non-Brain producer needs
  different codes, the *view* type has to change with it — a decision to make with
  Phase 22 in the room, not one to guess at now.

### Step 3 — `'self'` and `'world'` become provenance rows

Today `self`, `world` and `continuity` are answered by the Brain and therefore do
not get rows of their own; `brain` is the row. When Phase 22 lands, add `'self'` and
`'world'` to `CONSCIOUS_SOURCES` in `core/consciousness/types.ts` and give each a
reading in `readSources`. `'life'` is already a row, which is why the source list
is twelve long on this baseline.

The property to preserve: **a subsystem added to Core becomes another row in
`provenance` and at most another section, never another field on an existing one.**
That is why `sources` is a list over a closed set rather than twelve fixed fields.

### Step 4 — update the replay assertions

The live-Core replay suite compares snapshots across a restart. Adding a
contributor may add a session-scoped `since` to `uncertainty` (as
`cognition.governor-closed` already has), which is deliberately excluded from the
replay comparison because it is a fact about *this process*, not about the durable
record.

### What must not be done to close this out

- Do not fill `life` with a placeholder, a synthetic history or zeroes to make the
  snapshot look complete. That is the failure this lane is built to prevent, and
  the tests will catch it.
- Do not let a producer widen a closed union to `string` to make an adapter
  compile.
- Do not merge two producers behind one port.
- Do not add a Life/Self/World section that duplicates an owning domain's own
  standing projection.

## Red team

Every attack is a named test that asserts the invariant it tried to break.

- **sentinel leakage** — a fixture plants a distinct fake secret in every private channel Core has (memory content, memory subject, mission title and intent, context content and label and uri, relationship text and tags, attention text, worker message body, approval justification and proposal, run and task labels, a model prompt, a Relay connector payload), takes a snapshot, and asserts the serialised snapshot contains none of them.
- **the read-only surface** — the public protocol has no write verb; the preload allowlist does not mention consciousness; the main process registers no write channel; `Core` exposes exactly two consciousness methods.
- **STOP ALL** — under STOP ALL the snapshot still reports the stop, and `nextActions` is empty.
- **absence is not emptiness** — a Core with no subsystems, a Core with some, and a subsystem that throws all produce three different, distinguishable shapes, and none of them fabricates a value.
- **no fabrication** — a section whose source is absent reports `state: 'absent'` and zero; it never reports a plausible-looking run, mission, worker or memory.
- **forged inputs** — hand-built projections carrying extra keys, wrong enum members and oversized lists are bounded and dropped rather than trusted.
- **idempotence and determinism** — the same durable state twice produces deep-equal snapshots; a replayed journal produces the same snapshot; a reordered tick does not.

## Acceptance criteria

1. One snapshot answers: what Freya is focused on, what matters, what is waiting or blocked, who and what is involved, what changed recently, what is uncertain, and what is next.
2. The snapshot changes when the authoritative state underneath it changes, with no snapshot-specific event to change.
3. Replay and restart reproduce the same projection for the same durable state.
4. A missing subsystem degrades to a stated absence, never to fabricated content.
5. No private or raw content crosses the boundary, and this is proven by test rather than by review.
6. The public Phase 20 protocol is read-only, and its read-only-ness is asserted against the source.
7. No new durable state, no new command, no new renderer mutation authority.
8. **Not yet met, and stated as unmet:** Life (Phase 21) and Self/World (Phase 22)
   are consumed through ports with `life` reported as a stated absence. This
   criterion closes on rebase, not on merge.

## Verification

Run on 2026-10-03 against the Vault-era baseline `9016494`
(`vault-core-longcat`), on branch `prep/phase20-vault`.

**116 tests across 6 files, all Phase 20**, all passing:

| Suite | Tests | What it holds |
|---|---|---|
| `tests/core/consciousness/projection.test.ts` | 38 | The derivation, without a Core. Ported from the pre-Vault lane. |
| `tests/core/consciousness/coreIntegration.test.ts` | 18 | Live Core: replay, coherence, restart, mirror-not-truth. Ported unchanged. |
| `tests/core/consciousness/phaseDependency.test.ts` | 23 | **New.** The Phase 21/22 dependency state, the port seam, and the no-durable-truth boundary. |
| `tests/red-team/consciousness-leakage.test.ts` | 20 | Sentinel sweep over the serialised snapshot. Ported. |
| `tests/red-team/consciousness-positive-control.test.ts` | 3 | Proves the sweep can fail. Ported unchanged. |
| `tests/host/consciousnessBridge.test.ts` | 14 | The read-only lane and the absence of a write door. Ported. |

Also run: `npm run typecheck` (all three tsconfigs), `npm run lint`,
`npm run build`, and the full `npm test` suite. No test requires a network, a real
provider, a real account or a real secret.

Dev dependencies were installed with `--ignore-scripts` in this worktree, so no
native module was built and `package.json` / `package-lock.json` are unchanged.
The SQLCipher binding is untouched by this lane — Phase 20 opens no database and
has no native dependency.

### The dependency note, for the integrator

> **This branch adds no durable state and no write door, and it is incomplete by
> design.** It is rebased onto merged Phase 21 and Phase 22 before Phase 20 is
> called final. On this baseline every snapshot reports `health: 'degraded'` with
> `life` named in the reason, because `PLAN.md` §6 requires a Phase 21 Life
> contributor that does not exist yet. That is the correct reading of this build,
> not a defect to be smoothed over before merging. The four integration steps are
> in [Integration points](#integration-points-phase-21-and-phase-22).
>
> Do not close the gap by inventing Life or Self/World data, and do not merge this
> to `main` before Phase 21 and Phase 22 have settled.

### Findings from the adaptation

Two of the three findings below were found by the original suite and are recorded
here because they shaped the implementation rather than the assertions. The third
was found during this adaptation:

1. **The freshness reduction was backwards.** `weakestOf` took a *minimum* over a
   best-to-worst ranking, so a snapshot resting on one fresh source and nine
   absent ones reduced to `'fresh'` — the confidently incomplete picture this phase
   exists to prevent, reporting itself as correct.
2. **`'absent'` and `'unknown'` had been conflated** in the section `state`, so a
   Brain that existed but could not be read rendered as "there is no Brain".
3. **`recentChanges`, `uncertainty` and `nextActions` claimed `'available'` with
   empty lists** before Core had started. "Nothing changed", "nothing is
   uncertain" and "nothing is next" are claims about a Core that is up.

All three were the same mistake wearing different clothes: reporting the absence
of information as though it were a fact about the world.

Two more from this adaptation:

4. **The port type initially declared `confidence: number`.** The Brain's
   `Confidence` is a closed *string* union. The typechecker caught it, and the fix
   was to reuse the authoritative union rather than invent a parallel one — which
   is exactly the failure mode the ports were introduced to prevent, caught one
   layer earlier than it would otherwise have been.

5. **The Life listing inverted its own malformed-timestamp guarantee.** The first
   version sorted newest-first by *negating* `byInstant`. `byInstant` deliberately
   sorts an unparseable instant last so it cannot displace a well-formed record;
   negating that put the broken record *first*, where it reads as the most recent
   thing that happened. Rewriting it as sort-then-reverse has the same defect, for
   the same reason. The fix is `newestFirstByInstant` in `types.ts`, which orders
   newest-first and puts an unknown instant last on purpose.

   Worth noting what this says about the rest of the lane: the same
   sort-then-reverse shape is used by `buildAttention` for its inbox, so an
   unparseable `observedAt` lands at the head of that listing too. That is
   pre-existing and unchanged here, and it is a genuine finding for whoever owns
   Attention — recorded rather than fixed, because quietly changing another
   domain's ordering from inside Phase 20 is the kind of scope creep this lane is
   supposed to avoid.
