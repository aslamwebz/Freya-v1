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

Reading stops at the first line that is not a valid event, and everything from
that point on is truncated away.

| Condition | What happens |
| --- | --- |
| torn final write (no newline) | dropped; file truncated to the last good line |
| unparseable line | dropped; file truncated |
| unknown event type | dropped; file truncated |
| unsupported schema version | dropped; file truncated |
| sequence not a positive integer | dropped; file truncated |
| duplicate sequence | dropped; file truncated |
| reversed sequence | dropped; file truncated |
| invalid principal id | dropped; file truncated |
| malformed correlation or causation id | dropped; file truncated |
| payload not matching its own type | dropped; file truncated |
| **invalid line in the middle** | **dropped, and so is every valid event after it** |

The last row is the sharp edge, and it is deliberate. Truncation discards
events that were fine. That is the safe choice: a journal with a hole in it
cannot be replayed into security state, because the gap could be hiding the
revocation that came after it. The safe reading of a damaged log is the prefix
up to the damage, plus a record that the log was truncated.

A deployment that cannot tolerate truncation should refuse to start instead;
`JsonlEventStore.lastTruncation()` reports what was dropped so a caller can make
that decision.

In practice only the tail is recoverable, because the tail is the only place a
crash can leave damage.

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

`cognition.grant.consumed` carries `outputTokenBudgetReserved` — the
authorisation reservation — separately from `inputTokens`/`outputTokens`, which
are the provider's report. See [COGNITION-POLICY.md](COGNITION-POLICY.md#4-the-token-budget-is-reserved-before-the-call-and-never-refunded).

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
