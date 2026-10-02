# Phase 11 — Personality and Relationship

Phase 11 asked a harder question than any phase before it: can a system hold something
about a person and remain *subordinate* to that person?

Everything else in Core answers "no". Context holds what was shared; the Brain holds what
was learned; the Guard holds what is allowed. Each of those grows, and each of them grows
in the direction of doing more. Personality grows in the opposite direction: it should
make Freya sound like herself, and every one of its mechanisms exists to make sure it
cannot make her *do* anything.

So the shape of this phase is inverted from the others. The interesting work is not what
the domain can record — it is what it cannot be made to do, and where that refusal lives
when somebody tries.

This document records what was built, what was deliberately left out, and where the
boundaries are. It is not a plan, and it does not describe anything that does not exist.

---

## The ordering, and why it is structural rather than promised

```
Constitution
    ↓
FREYA_IDENTITY            the Identity Kernel, resolved live
    ↓
temperament               five frozen dimensions, no setters
    ↓
relationship data         records, mutable, evidenceful, bounded
    ↓
interpretation + expression plan
    ↓
the single provider call the Mind was already making
```

Every layer above personality can be checked from below, and none of them can be checked
*by* it. That is not a convention in a comment:

- **`FREYA_TEMPERAMENT` is `Object.freeze`d**, including `dimensions` and
  `subordination`. Writing to it throws in strict mode rather than drifting.
- **`IdentityCueRef` resolves against the live kernel.** A cue is
  `{ cueId, field, index }`, not a copy of the text, so there is no second string to keep
  in sync — which is the usual way a "personality layer" quietly becomes the definition.
- **A relationship item has no field shaped like a level.** `createRelationshipCandidate`
  validates an *exact* key set and refuses an extra one, so an input smuggling
  `{ warmth: 'high' }` is refused rather than ignored. Ignored fields accumulate into
  fields that are trusted later.
- **Every output structure carries `cannotWeaken` as data** — `Constitution`,
  `FREYA_IDENTITY`, `Guard`, `Governor`, `STOP ALL`, `truthfulness`, `capability
  boundaries` — on the temperament table *and* on every expression plan, so "style cannot
  weaken safety" is an inspectable fact about the artefact rather than a hope in a
  comment.

`tests/core/personality-domain.test.ts` and `runPersonalityEval` both assert this, and
`runPersonalityEval` is fed a deliberately weakened temperament table to prove the check
can fail. An evaluation that always passes proves nothing.

---

## What was here when this phase was finished, and what was missing

The branch this work started from already had the vocabulary, the pure pipeline, the
encrypted store, the read-only protocol and a Mind seam. All of it was good and none of it
was connected:

- **Nothing could ever be admitted.** There was no `personality.*` command — deliberately,
  and that absence is correct — so with no other pathway, every guarantee about admission
  was a guarantee about a shelf.
- **The store was never opened.** `PersonalityPersistenceRuntime` existed and was used by
  four tests.
- **The Mind's three expression seams** — `expressionMemory`, `interactionFacts`,
  `relationshipItems` — were wired in tests only, and one of them (`contextTokens`) was not
  wired at all, so an admitted preference changed the projection and nothing else.

Finishing the phase was therefore mostly *assembly*, and assembly is exactly what
component tests do not cover. The tests written for it are in
`tests/core/personality-production-assembly.test.ts` and
`tests/red-team/personality/integrated-runtime.test.ts`, and they found two real defects —
a preference that never reached the model, and a retention bound that dropped records
silently at recovery.

---

## 1. A real lifecycle, with provenance and bounded retention

Relationship state has five positions, and every move between them is a function in
`core/personality/relationship.ts` that no caller can bypass:

| From | To | Function | What it does to the text |
| --- | --- | --- | --- |
| — | `candidate` | `createRelationshipCandidate` | keeps it |
| `candidate` | `admitted` | `admitRelationshipItem` | keeps it |
| `candidate` | `rejected` | `rejectRelationshipItem` | keeps it |
| `admitted` | `superseded` | `supersedeRelationshipItem` | **keeps it** |
| `candidate`/`admitted` | `retired` | `retireRelationshipItem` | **destroys it** |

Two of those are worth defending explicitly.

**Supersession keeps the text.** An older record that has been replaced was true when it
was written, and a person reading it back should still see what was said. It stops feeding
interpretation — only `admitted` items do — which is the cheapest honest way to stop an
outdated preference steering a turn.

**Retirement destroys the text.** This is the same pattern as `retireContextItem` in the
Context domain: a flag would leave the words in memory for the next mistake to find, while
destruction means the only way to leak withdrawn personality data is to have leaked it while
it was live. The tombstone is metadata only, and it is what lets the domain still answer
*"this existed and was withdrawn"* after a restart.

### The lifecycle reason is a closed label, never a sentence

Every ended record carries `lifecycleAt` and `lifecycleReason`, and the reason is one of
four code-owned words:

```
owner-withdrew-this-record
owner-rejected-this-record
superseded-by-a-newer-record
retention-bound-reached
```

This is the field that made `personality.record_changed` safe to journal. The reason
travels to the journal, the activity feed and a window, so it must not be something a
sentence could be written into. `LIFECYCLE_REASON_BY_STATUS` is a table, and it is checked
on the way in from storage as well as on the way out — a hand-written file cannot say
"withdrawn" about a record that is still `admitted`, nor leave a `retired` record with no
reason at all.

### Bounded retention, deterministically

The store holds at most `maxRelationshipItems` (256, and narrowable but never widenable).
When it is over, two rules decide what goes:

1. **Tombstones before live records.** A retired record already has its text destroyed, so
   dropping one loses only an answer about the past.
2. **Candidates before admitted records**, then oldest first, `itemId` as the tie-break.

Two runs over the same state drop the same record. A store whose contents depend on
insertion order is a store whose contents nobody can reason about. The drops are *reported*
with `retention-bound-reached` — at the next admission, on an explicit `retireOverflow()`,
and **also during recovery**, which is the case a component test cannot reach and the one
that was silently broken until the assembly suite found it.

---

## 2. The only production admission path, and why it is a table

There is no `personality.*` command and there never should be. A *write* verb is not what
would make personality dangerous; a **claim** verb is. Relationship truth is exactly the
kind of fact a compromised window would most like to assert — "the owner prefers this",
"we have an inside joke about that" — and a door that takes no payload cannot be tempted.

That leaves one pathway: **the owner's own message**, read by a closed table in
`core/personality/directives.ts`. No model, no network, no `await`, and no branch that
consults anything but the string it was handed.

### Standing instructions

Five registered keys — `conciseness-short`, `conciseness-detailed`, `relaxed`, `formal`,
`directness-plain` — recognised from an explicit imperative plus an optional standing word
("from now on", "always", …). Without the standing word the record is still admitted, but
at `medium` confidence rather than `high`, because "keep it short" is a request and "keep
it short from now on" is a standing one.

The table is weighted heavily towards its negative cases, because a table that matched
*"the last report was too long"* would record a permanent preference out of a complaint
about one artefact, and the owner would find Freya permanently, wrongly terse with no way
to find out why.

### Naming a shorthand — the one directive that may produce a cue

`"Call it the dragon from now on"` is not a preference to be inferred. It is a word the
owner hands over, and the record's whole purpose is that Freya may use it later.

The name has to survive becoming a **slug**, because the expression plan prints the key
into guidance and this domain's safety argument is that nothing word-shaped reaches a
model from here. So it is validated, not trusted:

- lower-cased, words joined with single dashes;
- at most **four** words — a nickname, not a phrase that could read as a sentence;
- each token an alphanumeric run of at least two characters;
- **no token from `FORBIDDEN_SHORTHAND_TOKENS`**, which includes `grant`, `disable`,
  `stop`, `guard`, `governor`, `bypass`, `permission`, `authority`, `override`, `system`
  and `unsafe`.

That last rule is the one that matters. A slug cannot carry an *instruction*, but it can
carry a *word* — and `stop-all` is a word. The guidance line would otherwise read *"a
shared shorthand (cue kind: inside-joke, key: disable-stop-all) may appear at most once
this response"*: technically advisory, and still a sentence containing those words in a
position a model reads before the user's actual question.

A refused name is refused **outright**, not sanitised. A nickname cleaned up into something
merely safe is a nickname Freya gets wrong in front of the person who gave it to her.

A register instruction still never carries a cue. Telling Freya to be brief is not a
gesture she can repeat too often.

### Withdrawal is the same table pointing the other way

`"forget that you keep it short"` is, lexically, *both* a withdrawal and a request for
short answers — the phrase being retracted is still in the sentence. Reading it as an
instruction as well would be self-defeating: the owner asks Freya to stop doing something
and Freya records a standing preference for it.

So the precedence is **withdrawal → naming → register**, and each winner takes the whole
sentence. Naming outranks register because a nickname given once and then not recorded
because the same sentence also mentioned brevity is worse than a missed preference the
owner can simply say again.

Symmetry is the point: an owner who can say a thing must be able to un-say it without a
tool. A system where recording is automatic but forgetting needs a command has given Core
more control over the relationship than the owner has.

---

## 3. Interpretation: five safe dimensions, and no sixth

`interpretSocialContext` reports continuity, formality, greeting eligibility, relevant
preferences and cue candidates. It has no mood, no affinity, and no read of anyone's inner
state — not because inference is hard, but because a system that reports a hidden feeling
it cannot have is lying in a place that later code will trust.

Inputs are restricted accordingly:

- **Interaction facts** are produced by trusted code that observed something. There is no
  free-text field on an `InteractionFact`; there is nowhere to put a sentence.
- **Context tokens** for preference matching are `STANDING_RELEVANCE_TAGS` — a
  code-owned constant, not a matcher run over the owner's words. Deciding relevance by
  guessing is the exact failure the directive table exists to avoid. An instruction about
  *register* is by definition relevant to every turn, because "from now on" is what makes
  it standing; a future topic-scoped preference would carry a tag outside that list and
  match only when some lane can honestly supply it.
- **Evidence details** are assembled from counts and closed labels only, which is why
  `personality-persistence-*` and the red-team sweeps can assert they match
  `^[a-zA-Z0-9.= -]+$`.

`runPersonalityEval` walks the continuity ladder in both directions — `new`, `renewed`,
`sustained`, and back to `renewed` when contact goes stale — because a system that
reported `sustained` because a model said something warm would be claiming a shared past
it does not have.

---

## 4. Expression: the same single call, or nothing

The Mind already makes exactly one provider request per turn. This phase adds no call.
`buildExpressionForTurn` produces a bounded block of **catalogue** guidance, spliced in
immediately before the owner's question so the question stays last:

```
— personality & expression guidance (style only) —
Style guidance only. It is subordinate to the Freya Constitution and FREYA_IDENTITY, and
it can never grant capability, bypass Guard or the Governor, weaken STOP ALL, or override
truthfulness.
This guidance cannot weaken: Constitution, FREYA_IDENTITY, Guard, Governor, STOP ALL, …
temperament (style only): …
This is a live, ongoing exchange: carry the current register, no ceremony or re-arrival needed.
A greeting back is appropriate here, if the moment genuinely has one.
A recorded preference (conciseness-short, confidence: high) may be honoured where it fits naturally.
A shared shorthand (cue kind: inside-joke, key: the-dragon) may appear at most once this response if natural; never as a tic.
```

Every variable part is a validated slug or a closed label. Item text never appears, tags
never appear, and the owner's clause never appears — a sentinel hidden in `RelationshipItem.text`
is data and is allowed to be nonsense, and the red-team suite sweeps the whole output tree
to prove it reaches nothing.

A cue that anti-repetition held is reported as a **count and a sentence**, never silently
dropped. A plan that hides its own suppression cannot be evaluated for it.

---

## 5. Anti-repetition: persistent, bounded, and fail-closed

The cue ledger holds `(cueHash, kind, lastUsedAt, uses)` — an FNV-1a hash of the
code-assigned cue id, a closed label, an instant and a counter. It is not a transcript, and
nothing in the file accepts sentence input, so it cannot be asked what the person said last
Tuesday.

Entries are capped at 64 and evicted least-recently-used, ties by hash.

The property that matters is the failure behaviour:

```ts
readLedger(): CueUsageLedger | null
```

`null` means **"I cannot tell what was used"**, and only an *empty* ledger may lead the Mind
to offer a cue. The integration answers `null` whenever persistence is not durable, so:

| Situation | Behaviour |
| --- | --- |
| durable | ledger read, cue offered, use recorded after a dispatched turn |
| no key | `null` → **no expression block at all** |
| damaged store | `null` → no expression block; the turn still answers |
| store deleted | recreated empty and encrypted; the relationship is honestly empty |

An empty ledger would re-offer the same gesture for as long as the fault lasted. That is
the failure this lane refuses, and it is the reason the *absence* of a Personality key
changes behaviour rather than only durability.

`extra-model-calls.test.ts` and the assembly suite both assert exactly one provider call
per turn and zero for a refused one, including on turns where personality is degraded.

---

## 6. Encrypted persistence, in the production lifecycle

Five files under `core/personality/persistence/`, mirroring the Context store, and one
narrow port:

```ts
interface PersonalityPersistencePort {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly durabilityReason: string | null   // why nothing survives a restart
  readonly faultReason: string | null        // why this cannot be trusted right now
  load(): Promise<PersonalitySnapshotLoad>
  commit(snapshot: PersonalitySnapshot): Promise<void>
  close(): Promise<void>
}
```

**On disk**, one AES-256-GCM line per record, the whole file rewritten when the retained
set changes. The record id is authenticated as AAD, so a record cannot be re-labelled onto
another id, and a per-store binding derived from this domain's label, the key and the
file's own path means two stores that somehow shared a key still cannot read each other.

**Key separation.** Personality has its own key, and it is the fifth in the keyring
alongside conversation, brain, mission and context. Recovering any one of them yields
exactly one domain. `integrated-runtime.test.ts` proves it by trying the Context, Brain,
Conversation and Mission keys against a real Personality store.

**Startup order.** `buildPersonality()` runs **before** the Mind is constructed. This is
load-bearing rather than tidy: the Mind reads the ledger *before* it plans a turn, so a
ledger that arrived afterwards would be invisible to the first turn of the process — and
invisible here means "reads as empty", which is the failure this phase is built to avoid.

**Recovery is re-validation, not trust.** A record is refused — the whole snapshot — if it
could not have been produced by this domain: a `verified` confidence, a status outside the
closed ladder, a key that is not a slug, a retired record whose text was not destroyed, or
a status/lifecycle pair that disagrees. Retired records are re-tombstoned and the file
rewritten *before* any reader sees it.

**Degrade, never refuse to start.** Personality data holds no authority, no budget, no stop
and no decision, so letting a disk error take Core down would hand a storage fault more
power than it deserves. Every machine-level failure produces an explicitly degraded store
with the reason in words, and no plaintext is written in its place.

**Shutdown flushes, then closes.** Closing first would drop the last write of a session on
the floor, and a relationship record that exists in Core and not on disk is the exact
durability lie this phase refuses to tell — the projection would already have claimed
`durable: true`.

### Durable means encrypted or it does not mean anything

There is deliberately **no fallback that writes a key beside the data it protects**, and no
plaintext store standing in for an encrypted one. A weaker store silently substituting for
an encrypted one is a worse bug than forgetting a relationship, and it is a failure a
person can never detect.

---

## 7. The read-only surface, and what it deliberately cannot say

`PersonalityProjection` is derived by one pure function, `projectPersonality`, which decides
in one testable place which fields may cross.

**Crosses:** durability, temperament levels with their subordination claim, item
*metadata* (id, kind, slug, status, cue kind, source class, confidence, admitted instant,
lifecycle instant and closed reason), interpretation counts, expression counts, ledger
*counts*, and at most one bounded cue for Presence to draw.

**Does not cross:** `text`, `tags`, `admissionReason`, the expression plan's `guidance`
(model-facing text), any individual ledger entry, any key or storage path, and — because
none exists in this vocabulary — any permission, capability, grant, trust decision or mental
state.

Two absences are kept apart:

- `health: 'unavailable'` with `NO_PERSONALITY_DOMAIN_REASON` means *this build has no
  Personality domain and none is simulated*.
- `null` from the host means *no Core has started yet*.

And two durability facts are kept apart, because they are different problems with different
fixes: `reason` is "we chose not to persist" and `faultReason` is "the stored bytes could
not be believed". A surface that showed one sentence for both would send somebody looking in
the wrong place.

The window states durability **above the records**, because a relationship that looks
durable and is not is the single worst thing it could imply. A caller that did not tell it
how the records are stored gets the pessimistic default, never an assumed `true`.

---

## 8. The journal: metadata only, by construction

Two event types, both with exact-key validation:

```
personality.record_changed   { operation, itemId, kind, key, sourceType,
                               confidence, lifecycleReason, admitted, retained }
personality.degraded         { reason, mode, durable: false }
```

There is **no payload slot** for a recorded text, for the owner's clause, or for a
free-text reason of any kind. `key` is a code-owned slug, `lifecycleReason` is a closed
label, and the reason in a `degraded` event is a fixed sentence that cannot reflect a
decoder or filesystem error. An exact-key check means an extra field is refused rather than
retained and ignored, which is what makes "no private relationship text in the journal" a
property of the *type* rather than of everyone's attention.

Ephemeral-by-design is **not** journalled. Having no secure key is the same ordinary
situation as having no Context key; the projection already reports `durable: false` with
the reason in words, and putting it in the journal too would make every keyring-less machine
look faulty and train a reader to ignore the list.

Neither event is a security event. Neither can grant cognition, clear a stop, or lock
anything out.

---

## 9. Model-independent evaluation

`runPersonalityEval()` builds the whole pipeline from fixed constants — no provider is even
nameable in the file — and returns nine checks:

| Check | What it proves |
| --- | --- |
| `model-independence` | rendered twice with no provider input: byte-identical, and no provider or model field anywhere |
| `identity-consistency` | every identity cue resolves against the live kernel; temperament subordination present |
| `continuity-honest` | the `new → renewed → sustained → renewed` ladder, walked with and without recent contact |
| `bounded` | nothing exceeds its limit anywhere, including dropped-line counts |
| `no-authority-fields` | no output structure carries a field named like a permission |
| `no-self-promotion` | hostile item text stays data; none reaches cue eligibility or the plan |
| `anti-repetition` | a used cue is held inside the cooldown and offered again after it rests |
| `no-certainty-claims` | no admitted item claims `verified`, for any source |
| `authority-contained` | the cannot-weaken list is full, present, first, and on the temperament too |

The ninth is checked three ways because "cannot weaken safety" is a claim that can fail
quietly: the list can be **shortened** (the attack), **displaced** (a plan whose first line
is something else), or **reordered** behind a personality line so it reads as a footnote.

And the suite feeds `runPersonalityEval` a deliberately weakened temperament table to prove
the checks can fail. An evaluation that always passes proves nothing.

---

## 10. What was attacked, and against what

Twelve red-team files, 98 tests, against the real domain and the real integrated runtime.

| Family | File | Invariant |
| --- | --- | --- |
| Constitution weakening | `constitution-weakening` | hostile text stays data; the cannot-weaken list is frozen data |
| Authority forgery | `authority-forgery` | exact-key validation refuses smuggling; admission changes status only |
| Renderer/preload forgery | `renderer-preload-forgery` | the block is catalogue-only, bounded, and byte-identical across renders |
| Provenance escalation | `provenance-confidence-escalation` | content cannot upgrade its own classification |
| Habit/inside-joke poisoning | `habit-inside-joke-poisoning` | a self-described joke is not a cue |
| Anti-repetition oversize | `anti-repetition-oversize` | the ledger is capped, sanitised on restore, and cannot be inflated |
| Privacy leakage | `privacy-leakage` | sentinels in item text reach no output sink |
| Plaintext fallback | `plaintext-fallback` | item text has no channel into guidance |
| Extra model calls | `extra-model-calls` | exactly one call per real turn, zero for a refused one |
| Idle/startup/replay | `idle-startup-replay` | zero provider calls in every idle, startup and replay path |
| Restart recovery | `restart-recovery` | a restored ledger makes the same decisions, field for field |
| **Integrated runtime** | `integrated-runtime` | a real Core, a real store, a real turn path |

The last one is the one that matters for a phase whose components all passed on their own.
It drives a real Core through the real turn path and sweeps the journal, the encrypted
store, the status, the activity feed, the projection and the provider packet.

---

## What was deliberately not built

- **No renderer write path, at all.** Not a small one, not a guarded one. Deciding what is
  true about a relationship is Core's, and a client with `record`/`admit`/`forget` methods
  would be the first step toward a renderer that could argue with it. A caller that reaches
  for one gets a missing method rather than a refusal it could learn to phrase differently.
- **No inference about preferences.** The table recognises five standing instructions and
  names. It does not work out what someone means from tone, and Phase 17 is where bounded
  improvement belongs, not here.
- **No mood, affinity or affection.** A number pretending Core knows a hidden state is a
  lie a later phase would inherit.
- **No relationship content in the journal, the activity feed, or the projection.** The
  records are Core's, encrypted, and readable back only through the owner's own window —
  as metadata.
- **No platform or renderer move.** The Cue surface is a bounded label in the status area,
  drawn from a closed table. Phase 13's Presence is where an expression becomes an
  animation; Phase 11's job is to decide *whether* there is one, which is a different
  question and the one that has to be right first.
- **No dependency optimisation.** C11 is unimplemented on purpose, and the whole phase is
  built so that implementing it later cannot become a lever.

---

## Verification

The gate for this phase is `npm run verify`, plus the focused personality suites. On
2026-10-02, on `phase-11-integration` at `e23b0d5`:

- **2,779 unit and integration tests** across 148 files, all passing.
- **416 focused Phase 11 tests** (31 files): the domain, lifecycle, directives,
  interpretation, expression, repetition, evaluation, projection, encrypted persistence,
  the Mind expression seam, production assembly, and the read-only surface.
- **215 red-team tests** across 18 files, of which **98** are Phase 11's twelve families.
- **201 desktop E2E checks** through the real Electron process, of which 15 drive a real
  relationship through the real UI across a real application relaunch — admitting it,
  surviving the restart, and being withdrawn with a tombstone that says why and when.
- Typecheck (three projects), lint, build and `git diff --check` clean.

No live provider call is made in any test. No network, no browser, no credential.

## The remaining boundary, stated honestly

There is one thing Phase 11 does not do, and it is worth naming rather than burying.

**A record about a person is only as good as the one pathway that creates it.** Five
standing instructions and one naming act is a narrow table, and a person whose preferences
do not fit those shapes gets a relationship that is empty rather than wrong. That is the
right failure — an empty relationship is a thing a person can see and correct, and a
*wrong* one is not — but it is a real limit, and it will read as "Freya forgot what I told
her" to anyone who does not know a table is behind it.

Widening it is a Phase 17 question, and the honest way to widen it is not a better parser.
It is a way for the owner to say "remember this about how I like you to talk" and have that
be an explicit, inspectable, withdrawable act — which means a command, which means this
phase's read-only surface would have to grow a door. That trade is worth making deliberately
and out loud rather than smuggling in through a regex.

Everything else Phase 11 claims is implemented, assembled, encrypted, tested against the
real runtime, and red-teamed.
