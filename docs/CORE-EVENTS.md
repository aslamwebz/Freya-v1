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

The remedy is to repair or remove the log. Recovery truncates the damaged
segment on disk, so a subsequent start reads a clean prefix and comes up `ready`.
A *running* Core does not upgrade itself, because it cannot know the file changed
underneath it.

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

`model.request.started` counts a call and nothing else — it is the only record
that a provider was reached — and `model.request.completed` accumulates what was
reported. See [COGNITION-POLICY.md](COGNITION-POLICY.md#4-the-token-budget-is-reserved-before-the-call-and-never-refunded).

`cognition.allowed` does not name a provider: authorisation happens before one is
chosen.

### Model execution
`model.request.started` · `model.request.completed` · `model.request.failed`

`started` increments the durable call total, because it records an attempt.
Token totals accumulate only from `completed`, and stay `null` — not zero — when
a provider reports no usage.

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
