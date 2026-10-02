# Core events

The durable journal: what is in it, how it is written, and what happens when it
is damaged.

The log lives at `<userData>/core-events.jsonl`. One JSON object per line,
`fsync` before the append resolves. It is a security journal, so the two things
that matter most about it are that it cannot be corrupted into saying something
false, and that it never contains anything the user would not want copied into
a backup.

---

## The envelope

Every event has this shape, permanently:

```ts
{
  eventId: string          // unique id
  sequence: number         // positive, strictly increasing across the log
  type: CoreEventType      // from the closed CORE_EVENT_TYPES vocabulary
  schemaVersion: number    // 1
  occurredAt: string       // ISO-8601 instant
  source: 'core' | 'renderer' | 'system'
  actor: PrincipalId       // 'owner' | 'system' | 'agent:*' | 'module:*'
  correlationId: string    // ties related events together
  causationId: string|null // the event that caused this one
  payload: …               // shape depends on `type`
}
```

Two rules hold for all of Core:

1. **An event becomes visible to subscribers only after its append succeeds.**
2. **Replay never appends, never publishes, and never causes a side effect.**

---

## Ordering under concurrency

`EventFabric.append` runs the whole body — sequence assignment, the durable
write, and publication — inside a queue, one at a time, in call order.

Without that, every in-flight caller reads `sequence + 1` before any of them has
written. The log ends up handed a duplicate, and the store rejects a write that
had already partly happened. The regression test fires 200 concurrent appends
and checks the durable log, not just the returned values, for exact
monotonicity.

The queue never rejects, so **one failed append does not poison it**: the next
task runs whether the failed one resolved or threw, and the failed append gives
its sequence number back rather than leaving a hole.

Publication happens *inside* the queue so that subscribers see events in
sequence order. One constraint follows: a subscriber must not `await` an append,
because it would wait behind itself.

---

## Recovery policy

Reading stops at the first byte that is not a valid event, and everything from
that point on is truncated away. What recovery *reports* depends on why it
stopped, because two of the reasons are not the same kind of thing at all.

### The two kinds of damage

**A torn tail is a crash.** The log ends part-way through a line, with no
terminator. Those bytes were never committed, so the complete prefix before them
is the whole truth. The Core starts `ready` and says so in
`CoreStatus.integrity` — `integrity: 'torn'`, with the discarded byte count.

**Anything else is corruption.** A *complete* line that fails validation was not
produced by an interrupted write. It means the journal contains something this
code did not write, or was edited, or arrived out of order. The Core starts
`degraded`, reports `integrity: 'corrupt'` with the line number and the reason,
and **refuses all cognition** — see below.

| Condition | Kind | What happens |
| --- | --- | --- |
| final line has no terminator | torn | dropped; file truncated; Core is `ready` |
| unparseable line | corrupt | dropped; file truncated; Core is `degraded` |
| unknown event type | corrupt | as above |
| unsupported schema version | corrupt | as above |
| sequence not a positive integer | corrupt | as above |
| duplicate sequence | corrupt | as above |
| reversed sequence | corrupt | as above |
| invalid principal id | corrupt | as above |
| malformed correlation or causation id | corrupt | as above |
| payload not matching its own type | corrupt | as above |
| **invalid line in the middle** | corrupt | **dropped, and so is every valid event after it** |

The middle-line case is the sharp edge and it is deliberate. Truncation discards
events that were fine, because a journal with a hole in it cannot be replayed
into security state: the gap could be hiding the revocation that came after it.

### Why corruption denies everything

A corrupt log still replays — the surviving prefix is real — but it is not the
*whole* history. If a STOP ALL was written after the damaged line, truncation
discards it, and a Core that replayed naively would come up **healthy and
unstopped**: reporting exactly the state the user tried to leave behind by
stopping.

So the Governor checks journal trust before anything else, above the replayed
latch itself. A Core that cannot vouch for its log denies every request with
`journal-not-trustworthy`, and the projection reports `governor.status` as
`deny_all` regardless of what the latch says.

### Why it survives a restart

Truncation leaves a **clean** file. On its own that is the whole bug: the next
start would read the prefix, find no damage, and come up `ready` and unstopped —
having silently lost the latch that came after the damage. Recovery fixing the
file is what makes the damage disappear, so the record cannot live in the
recovery report either, because that dies with the process.

Two things make the fault durable:

1. **The damaged bytes are preserved, not discarded.** Before the file is
   truncated it is copied to `core-events.jsonl.quarantine`, with a `.txt` note
   beside it. Nothing is thrown away — including any event that followed the
   damage, which is what somebody needs in order to decide what was really in
   this journal. A second corruption does not overwrite the first.
2. **The fault is written into the trusted prefix** as a `core.integrity_fault`
   event, naming the line, the reason and the quarantine path. Appends land at
   the end of the file, and a reader stops at the first bad line, so it could not
   be appended *after* the damage; putting it in the prefix is what makes it
   readable and durable.

Every subsequent start replays that event, so the Core stays `degraded` and every
request stays denied, indefinitely. `CoreStatus.integrity` reports the recorded
fault on those starts, with the quarantine path in the reason.

A `degraded` start writes **`core.degraded`, not `core.ready`.** A `core.ready`
in the journal would be a claim a reader of the log cannot check, and the one
thing this state must not do is assert something untrue about its own readiness.

### The remedy

There is no recovery UI in Phase 1, so recovery is deliberately manual:

> Stop Freya. Read `core-events.jsonl.quarantine` and its `.txt` note. Decide
> what was actually in the journal — in particular whether anything that
> followed the damage should have taken effect. Then either restore a known-good
> journal, or delete `core-events.jsonl` to start from empty.

Only removing or replacing the journal clears the fault. There is deliberately
no way to do it by restarting.

A *running* Core does not re-read the log either: it cannot know the file changed
underneath it, and the state it derived would shift without an event explaining
why.

### Reading the report

`JsonlEventStore.recoveryReport()` returns:

| Field | Meaning |
| --- | --- |
| `tornTail` | the log ended mid-line |
| `corruption` | the line number and reason, or `null` |
| `eventsRead` | complete events read and believed |
| `bytesDiscarded` | bytes dropped, including any torn tail |
| `trustworthy` | `false` whenever `corruption` is set |

`CoreStatus.integrity` carries the same facts in a form a person can read, and it
is always present. A healthy journal says so explicitly, because the absence of a
warning is not the same thing as a warning that is absent — and the integrity
block is not folded into `CoreStatus.faults`, which is an advisory list.


---

## Validation

`core/events/validate.ts`. Small explicit checks, one per way a forged line
could change behaviour. "Looks like an envelope" is not a standard.

A line must have: a well-formed `eventId`; a type in the vocabulary; the
supported `schemaVersion`; a positive integer sequence **greater than the
previous one**; a parseable `occurredAt`; a `source` of `core`/`renderer`/
`system`; an `actor` that is a real principal id; well-formed correlation and
causation ids; and a payload matching the shape declared for its type.

`parseDurableEvent` never throws and never returns a partial event. It returns
the event or `{ ok: false, reason }`, and the caller treats the latter as "the
log ends here".

The principal check is the one that matters most: it is what stops a hand-written
line from acting as `owner`.

---

## What is deliberately not in the journal

**Command content.** `command.received` records the command id, the character
length, and which surface it came from. Not the text.

An audit journal is read by people, shipped in backups, and kept far longer than
a conversation. Whatever a user types belongs in conversation storage, which has
its own retention rules. The journal needs only enough to answer "did this
happen, and was it this long".

A test reads the file on disk and asserts that a submitted secret — a password
and a token, both plausible — appears nowhere in it, and that no state
projection carries it either.

**Prompts and completions.** `cognition.requested` records the request id, its
kind as origin and cause, and the requested token ceiling. The prompt text lives
in memory for the duration of the call and is never written.

**Credentials.** The NanoGPT key is read into a closure at construction and is
never returned by `status()`, never logged, and never recorded in an event.

**What Freya learned.** The Brain holds the most valuable long-term state in the
system and the journal is the least-protected place it could go: audit logs get
read, copied, exported into backups and forwarded to whoever is debugging. So
every `brain.*` event carries ids, counts, source classes and lengths — never a
memory's text, and never an entity's name:

```
  brain.memory.admitted      memoryId, kind, source, confidence, status,
                             conflictsWith, contentLength
  brain.world.entity_noted   entityId, entityType, nameLength, sourceType
  brain.world.observed       observationId, sourceType, statedLength
```

An entity's name is *measured*, not recorded. A person's name in an audit log is a
copy of it in the one place Freya does not protect as well as the Brain.

**Search queries and research questions.** The `research.*` family carries ids, a
closed stage, integer counters and fixed failure codes — no query, no URL, no
domain, no snippet, no page text, no answer, no provider diagnostic. The validator
rejects an **unexpected key**, not merely an invalid one, because a payload with
the right fields plus a query would pass every field check and quietly keep it.

**Recall.** There is deliberately no `brain.recalled` event, and no
`research.recalled` either. Recall happens
constantly, and journalling it would turn the log into a permanent record of what
Freya connected to what — every association, for as long as the journal is kept.
The Vault shows recall on demand instead.

---

## Brain events are not security events

`brain.degraded` records that the Brain's own hash chain or record log could not be
believed. It is **not** in `SECURITY_EVENT_TYPES`, and must never be.

A Brain fault cannot grant cognition, clear a stop or widen a budget — and, less
obviously, it does not *lose* authority either. Unreadable long-term knowledge is
neither permission nor lockout. Reporting it in the security stream would let a
disk error masquerade as a safety posture, and let a real safety problem look
like a disk error. Core keeps running, conversations keep working, and the Brain's
own health is reported in its own projection.

---

## The event types

### Lifecycle
`core.started` · `core.ready` · `core.degraded` · `core.stopping` · `core.stopped`

### Commands
`command.received` — metadata only, as above.

### Guard and STOP ALL
`guard.decision` · `security.stop_all.activated` · `security.stop_all.cleared`

`security.stop_all.*` are the only events that change durable security state,
and they are the reason the validator checks principal ids.

### Cognition governance
`cognition.requested` · `cognition.allowed` · `cognition.denied` ·
`cognition.authorization_required` · `cognition.grant.created` ·
`cognition.grant.revoked` · `cognition.grant.consumed`

Two separate events, because conflating them is what made the accounting wrong:

- `cognition.grant.reserved` — written *before* the provider is called. Carries
  this call's share of the output allowance. The reducer **adds** it to the
  grant's total, so two callers cannot overwrite each other's reservation.
- `cognition.grant.usage_reported` — written after. Carries what the provider
  said for that one call, with nulls when it said nothing. The reducer adds
  those figures to the grant's reported totals.

`model.request.started` is the explicit record that a provider was **reached**.
That word is load-bearing: the gateway also records `model.request.failed` when
*no* provider could be selected at all, and the two have opposite usage
consequences. During replay the two are told apart by whether a matching
`started` was written first — never by looking at a provider's name or kind.

An attempt is counted at `started` and records no gap, because the provider had
not declined to report; it had not answered yet. See
[COGNITION-POLICY.md](COGNITION-POLICY.md#reported-usage-accumulates-and-is-never-a-total-on-its-own)
for what each outcome contributes. See [COGNITION-POLICY.md](COGNITION-POLICY.md#4-the-token-budget-is-reserved-before-the-call-and-never-refunded).

`cognition.allowed` does not name a provider: authorisation happens before one is
chosen.

### Model execution
`model.request.started` · `model.request.completed` · `model.request.failed`

`started` increments the durable call total, because it records an attempt.
Token totals accumulate only from `completed`, and stay `null` — not zero — when
a provider reports no usage.

### Brain
`brain.seeded` · `brain.memory.admitted` · `brain.memory.reviewed` ·
`brain.memory.archived` · `brain.world.entity_noted` · `brain.world.related` ·
`brain.world.observed` · `brain.experience.recorded` · `brain.degraded`

Metadata only, as described above. Two details worth naming:

- **`brain.seeded` is written once, not once per launch.** Seeding is idempotent,
  and re-announcing it would put a "seeded" event in the journal for a Brain that
  was seeded weeks ago — which a reader would reasonably ask about.
- **`brain.world.related` carries `conflictingRelations`.** A non-zero count means
  the Brain now holds two *current* claims that disagree. That is a fact about the
  Brain's honesty and it is exactly what an audit reader needs to see: the
  difference between "Freya learned this" and "Freya learned two contradictory
  things". Neither relation replaces the other.
- **User-authored archive reasons and relation predicates stay inside the encrypted
  Brain.** The audit event carries only a fixed operation marker plus ids/counts;
  semantic text is not duplicated into the plaintext journal.

Every Brain payload is validated by the same `PAYLOAD_RULES` table as everything
else, reading named fields rather than passing the object through — so a
hand-edited line cannot smuggle in a field the schema does not name.

### Research
`research.search_started` · `research.search_completed` · `research.search_failed` ·
`research.read_started` · `research.read_completed` · `research.read_failed` ·
`research.started` · `research.progress` · `research.completed` · `research.failed` ·
`research.cancelled`

All eleven share **one** payload shape, because the fields that must never appear
are easier to guarantee for one type than for eleven:

```jsonc
{
  "operationId": "op-1",      // an id Core issued
  "sessionId": null,          // the managed browser session, when the stage had one
  "stage": "searching",       // closed enum
  "counters": { /* 8 integers the subsystem counted itself */ },
  "failureCode": null         // a ResearchErrorCode, never a message
}
```

A source URL does reach the renderer — a person needs it to check a claim, and a
citation that cannot be followed is decoration — but it reaches the **renderer**, not
the journal. The journal sees a count.

Expected failures are reduced to fixed public codes before they reach anything the
renderer can see. A provider that throws `FAKE_SECRET C:/private/key` is contained
twice: `safeResearchError` at the research result boundary, and the gateway's own
recorder at the journal boundary.


### Work

`work.run.created` · `work.run.started` · `work.run.resumed` · `work.run.paused` ·
`work.run.waiting` · `work.run.awaiting_approval` · `work.run.completed` ·
`work.run.failed` · `work.run.cancelled` · `work.run.recovered` ·
`work.step.ready` · `work.step.started` · `work.step.verified` ·
`work.step.failed` · `work.step.cancelled` · `work.step.skipped` ·
`work.action.started` · `work.action.completed` · `work.action.failed` ·
`work.action.cancelled` · `work.observation.recorded` ·
`work.verification.requested` · `work.verification.completed` ·
`work.approval.requested` · `work.approval.approved` · `work.approval.denied` ·
`work.approval.cancelled` · `work.approval.expired` · `work.task.created` ·
`work.task.updated` · `work.task.attached` · `work.task.completed` ·
`work.limits.exceeded`

Metadata only, and the rule is the Brain's with more force, because the content here
is richer than a memory's: a step's input is whatever a capability is about to be
handed, and an observation's data is whatever it just returned.

```
  work.observation.recorded   observationId, kind, summaryLength, detailLength
  work.step.started           runId, stepId, stepKey, index, capability, attempt
  work.action.started         runId, stepId, actionId, attempt, capability, principal
```

Both lengths, never the text. Step labels, step inputs, task titles and
verification reasons are absent entirely — there is no field they could occupy.

Four details worth naming:

- **`work.approval.requested` is the transition, not a note beside one.** It is the
  moment a run and its step stop and begin waiting on a named decision, so one event
  carries one fact. It is also what makes "nothing ran yet" checkable: the record
  exists strictly before any `work.action.started` could.
- **`work.run.recovered` carries `previousStatus` in its payload** rather than
  reading it back from state, because after a restart "what this run was doing" is
  precisely the thing that is no longer knowable. The fact that a status had to be
  reconciled is the point: the journal records that history was *not* proof of
  execution.
- **`work.action.failed` is not a failed step.** The step keeps its remaining
  attempts, and each one writes its own action, observation and verification events,
  so a flapping capability's history stays whole instead of collapsing into one
  error.
- **`work.limits.exceeded` exists so a restart cannot hide one.** A ceiling that
  stopped a run is a fact about the run, not only about the process that enforced
  it.

### Work payloads reject fields they do not name

Every `work.*` rule goes through `workRule()`, which **refuses a payload carrying a
key the schema does not list** — and so does the nested step seed.

The older families read named fields and ignore the rest, which is a real defence:
an undeclared key has nowhere to be read from, so it never reaches a reducer or a
projection. It is not enough for Work. The argument for putting execution history in
this file at all is that there is *no field a body could hide in* — and ignoring an
undeclared key still lets somebody hand-editing the file write a value to disk. The
difference between "the reducer ignores it" and "it was never accepted" is the whole
claim.

Work is new, so it starts the stronger way. Adding the same check to an older family
is a schema-version question rather than a code one, and belongs with whatever next
changes that family's payload.

### Missions

`mission.created` · `mission.activated` · `mission.paused` · `mission.resumed` ·
`mission.cancelled` · `mission.failed` · `mission.completed` ·
`mission.run.attached` · `mission.verification.requested` ·
`mission.verification.completed` · `mission.limit.exceeded`

Metadata only, and the rule is the Work one, because the content here is the most
sensitive thing the journal has ever been asked not to hold. A Mission's title,
intent and success criteria are what somebody asked Freya to accomplish, in their
words.

```
  mission.created                 missionId, createdAt, deadlineAt, limits, status
  mission.<transition>            missionId, from, to, reason, verifierId
  mission.verification.requested  missionId, verifierId, runIds
  mission.verification.completed  missionId, verifierId, outcome
  mission.limit.exceeded          missionId, limit
```

Four details worth naming:

- **No Mission payload has a slot for the Mission's text.** Not in the transition
  events, not in the verification events, and not in `created`. The encrypted store is
  the only place it exists, and the validator rejects an *unexpected key* — so a
  payload carrying the right fields plus an `intent` is refused rather than quietly
  kept. That is D25's rule, and here it protects something a person wrote rather than
  something they searched for.
- **`mission.completed` cannot be folded without a verification that passed.** The
  transition table cannot enforce this, because `active → completed` is a legal
  edge; the reducer does, by requiring a `mission.verification.completed` whose
  outcome is `passed` and whose `verifierId` matches the one named on the transition.
  Without it, a three-line hand-written journal manufactured a completed Mission.
- **`mission.resumed` is separate from `mission.activated`** even though both land on
  `active`, because only the origin tells them apart — and a journal that cannot
  answer "was this ever paused?" cannot be audited.
- **`mission.verification.completed` records a `timeout`.** Phase 6 writes *no*
  verification event when a deadline lands mid-verification, leaving it `requested`.
  Missions differ deliberately: at a deadline we hold positive knowledge that no
  verdict arrived, which is a different fact from "nobody has answered", and that is
  exactly what a crash leaves behind. The outcome recorded asserts nothing about the
  Mission — it stays `active`.

### No Mission event is a security event

None of the eleven is in `SECURITY_EVENT_TYPES`, for Work's reason: a Mission event
describes Freya *working toward* an outcome. A Mission that reached `completed` says
nothing about whether Freya may think next, and a ceiling that was hit says nothing
about the authority to reach it. Reporting either in the security stream would let an
ordinary failure masquerade as a safety posture.

The Mission fault that does exist is reported where it belongs, and is also not a
security event: a Mission content store that fails authentication reports
`persistence.reason` and refuses writes. It cannot grant cognition or clear a stop,
and — like a Brain fault — it does not lose authority either.

### No Work event is a security event

Not in `SECURITY_EVENT_TYPES`, and none may be. A Work event describes Freya *doing
work*: planned, attempted, observed, verified, decided. A run that reached
`completed` says nothing about whether Freya may think next, and a ceiling that was
hit says nothing about the authority to reach it. Reporting either in the security
stream would let an ordinary failure masquerade as a safety posture — the same
argument that keeps `brain.degraded` out.

The genuinely security-relevant part is already recorded where it belongs:
`guard.decision` is written every time Guard refuses a capability, and
`work.action.started` names the principal whose capabilities were evaluated.

### Attention

`attention.event.ingested` · `attention.decision.made` ·
`attention.budget.exceeded` · `attention.schedule.registered` ·
`attention.schedule.fired` · `attention.schedule.cancelled`

Metadata only, and the rule is the strictest family's: an event's **text** is
process-local data, never written here, and there is **no slot** for it. The
validator rejects an unexpected key, so a payload with the right fields plus a
`text` is refused rather than quietly kept.

```
  attention.event.ingested       eventId, dedupeKey, source, kind, goalRef,
                                 textLength, severityHint, occurredAt, dueAt
  attention.decision.made        decisionId, eventId, source, kind, goalRef,
                                 outcome, importance, urgency, reason, cueCode, focus
  attention.budget.exceeded      source, goalRef, limit, observed
  attention.schedule.registered  scheduleId, kind, goalRef, severityHint, dueAt,
                                 intervalMs, maxRepeats, condition
  attention.schedule.fired       scheduleId, eventId, repeats
  attention.schedule.cancelled   scheduleId, reason
```

Four details worth naming:

- **`do-nothing` is written like any other outcome.** A decision not to act is a
  decision, and a journal that recorded only the loud outcomes would misrepresent
  how often Freya stays quiet.
- **`dedupeKey` is the replay defence.** It is derived from the source's own
  reference when it has one, so a re-delivered event is recognised across a restart
  and produces no second decision.
- **`source` is assigned by Core.** It is a closed label, never read from a payload,
  so a hand-edited line cannot claim `system` to reach `critical`.
- **No attention event is a security event.** A decision cannot grant cognition,
  clear a stop or widen a permission, and a budget that ran out says nothing about
  the authority to run anything — the same argument that keeps `work.*` and
  `brain.degraded` out of `SECURITY_EVENT_TYPES`.

---

## Replay

`EventFabric.replay(initial, reducer)` folds history into a value. It cannot
append, publish, or call out: the reducer is a pure function, so a reducer with
a side effect would be violating its own type rather than merely being unwise.

One reducer serves both replay and live operation. After each durable append the
fabric publishes to a subscriber running the *same* reducer, so there is no
second code path that could drift from the log.

---

## Reading it by hand

```bash
# what Core has recorded, newest last
tail -n 20 "$APPDATA/freya/core-events.jsonl"

# just the sequence numbers
grep -o '"sequence":[0-9]*' core-events.jsonl | tail -20
```

The log is human-readable on purpose. An audit journal a person can read with a
text editor is worth more than query speed at these volumes.
