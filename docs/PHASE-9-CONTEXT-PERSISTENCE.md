# Phase 9 — Context: encrypted durability and restart recovery

Phase 9 built a Context domain that can hold what a person shared and refuse what it
should. Nothing in it survived a restart, and it said so plainly rather than writing a
plaintext file of somebody's selections. This lane is the other half of that sentence:
context that **does** survive a restart, encrypted, in its own storage domain, and that
reports honestly when it cannot.

This document records what was built and why. It is not a plan, and it does not describe
anything that does not exist yet.

---

## What this lane is

Five files under `core/context/persistence/`, and one idea: **a narrow port, with an
encrypted adapter and an honest ephemeral one.**

| File | What it is |
| --- | --- |
| `port.ts` | The vocabulary. `ContextPersistencePort`, `ContextSnapshot`, and what a caller is told about durability. No logic, no I/O. |
| `errors.ts` | One error class and one closed code table, so a fault can be caught without loading crypto. |
| `snapshot.ts` | The recovery gate: every record off disk is re-checked against the domain's own closed tables before it is believed. |
| `encrypted-store.ts` | AES-256-GCM at rest, Context's own key domain, damaged-and-therefore-read-only. |
| `ephemeral-store.ts` | No key, no file, no write path at all — and `durable: false` in words a person can read. |
| `open.ts` | The one entry point: a factory that never lets a disk or a keyring take Core down. |
| `recovery.ts` | Reading a recovered snapshot: total order, one record by id, and destroying what expired while the process was down. |

The domain itself is untouched. `core/context/` still imports nothing outside itself, reads
no clock, and cannot reach a disk. This lane meets it at one seam, and the seam is the
whole of what an integration gets to assume:

```ts
interface ContextPersistencePort {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly durabilityReason: string | null   // why nothing survives a restart
  readonly faultReason: string | null        // why this cannot be trusted right now
  load(): Promise<ContextSnapshotLoad>
  commit(snapshot: ContextSnapshot): Promise<void>
  close(): Promise<void>
}
```

Five members. No path, no key, no cipher, no file layout, and no way to write a record the
domain did not produce. Issue #27, which owns `core/index.ts`, can hold exactly this and
nothing more.

---

## 1. What is on disk, and what is not

One encrypted line per retained record, the whole file rewritten when the retained set
changes:

```
line = { v, contextId, nonce, cipher, tag }
       \_______ authenticated as AAD ________/
```

**The only readable byte in the file is a record id.** Content, label, URI, scope,
provenance, the TTL, the measurements and the revocation reason are all inside the
ciphertext. A stolen laptop, a synced folder or a support bundle yields a list of ids and
nothing else — and an id cannot be resolved without the Context key, so even the list
cannot be turned back into "this person was looking at their mortgage paperwork".

Each part of the design is there for a reason:

- **AES-256-GCM, authenticated on every read.** A record that was edited, truncated or
  swapped fails to open and is reported. There is no "decrypt anyway" path, because
  accepting a record that failed authentication would mean inventing the content it used
  to hold.
- **A fresh nonce per record, per write.** GCM nonce reuse under one key leaks the XOR of
  two plaintexts and the authentication key. Rewriting a record gives it a new nonce, so
  identical content never produces identical bytes.
- **The record id is AAD.** A record cannot be re-labelled onto another item's id: moving
  one item's content onto another's id changes the tag and the read fails.
- **A per-store binding in the AAD**, derived from this domain's label, the key and this
  file's own path. Two Context stores that somehow shared a key still cannot read each
  other.
- **Temp-then-rename.** A crash leaves either the previous file or the new one, never a
  half-written store that opens as "no context at all" — which is the failure a person
  would read as data loss.
- **Bounded twice.** The domain's `CONTEXT_LIMITS` are the real bound; `MAX_CONTEXT_RECORD_BYTES`
  and `MAX_CONTEXT_SNAPSHOT_BYTES` are an independent second gate, so a caller who forgets
  to normalise cannot use the encrypted store to write an unbounded file.

Whole-file rather than append-only, because the retained set is small, bounded and
*replaced* constantly: an item is revoked, an item expires, a purge drops a tombstone. A log
of a set that shrinks needs deletions, and a deletion that is not authenticated is a hole.

---

## 2. Context is its own storage and key domain

The Context key is not the Mission key, not the Brain key and not the conversation key.
There are four independent secrets, and the separation is enforced rather than requested:

- the AAD carries this domain's own label, `freya.context.v1`, so a Mission file handed to
  a Context store does not merely decrypt into the wrong thing — it does not decrypt at
  all;
- the store binding is derived from that label as well, so a wrong-domain key produces a
  different binding *and* a different prefix;
- a key of the wrong length is refused outright rather than padded.

This is not ceremony. A Mission is about somebody's plans, a Brain is about their life and
past, and Context is the raw private text they pointed at in the moment — a selected
paragraph, a file's title, a tab's URL. Recovering any other domain's key must not yield
the thing they were looking at when they spoke.

Core never generates this key and never persists one. A host obtains it from OS secure
storage and supplies it; a Core without one gets the ephemeral port, which is a different
kind of decision made in a different lane (`electron/keyring.ts` owns the domain list).

---

## 3. Recovery: what comes back, and what deliberately does not

`load()` returns a snapshot of retained records, or a refusal. What is restored is exactly
what was true:

- **scope** — each item keeps *its own* scope, kind-for-kind. An item shared into one
  conversation cannot surface in another after a restart, and a refusal never names another
  conversation's ids.
- **provenance** — source, capture instant and origin id. A `host_report` item comes back
  still naming the record it came from, because "the host said so" is only ever admissible
  when it points at something the host was given.
- **TTL** — `expiresAt` to the millisecond. A store opened with a *smaller* `maxTtlMs` than
  the file was written under refuses the record rather than admitting it with a shortened
  life and calling that recovery.
- **revocation** — `revokedAt` and the stated reason. This is why tombstones are persisted
  at all: a revocation that leaves no record cannot be answered `revoked` after a restart,
  it degrades into "there is nothing here", and a person who took something back would find
  it quietly return.
- **measurements** — `contentLength` and `labelLength` are taken at admission and survive
  destruction, so audit can still report that a 3,900-character selection used to be here
  without holding a character of it.

What does **not** come back is the current scope:

```ts
resolveContextReference({ term: 'here' }, recovered.records, null, now)
// { ok: false, reason: 'no_active_scope', candidateIds: [] }
```

A scope is where somebody shared something; the *current* scope is live session state.
Restoring it would point "here" at a conversation that is no longer happening, on the
strength of a file. So recovery returns records and no scope, and the resolver refuses
`here` until a caller declares where it is. Fail closed, in the domain's own words.

### Expiry that happened while Freya was down

A shutdown is just a very long gap between two looks, and the domain's expiry rule is
destruction rather than a filter at read time. So a snapshot that sat on disk overnight
arrives holding the content of a selection whose TTL ended hours ago.

`retireContextSnapshot(snapshot, now)` applies the same destruction, using the domain's own
`contextItemState` and `retireContextItem`, at an instant the *caller* supplies. Recovery
is thus a question with a stated answer rather than a fact this lane invented, and a test
can ask it about a fixed moment. An unusable instant retires nothing: a clock that is not a
clock must not destroy anything, in the same way it must not declare anything live.

---

## 4. Three stated states, and a refusal for all the damage

`durabilityReason` and `faultReason` are separate on purpose. Conflating them is how a
store ends up reporting `durable: true` while every read is failing: degradation was
tracked, it was just never read by anything a window could see.

| State | `mode` | `durable` | `faultReason` | What it does |
| --- | --- | --- | --- | --- |
| Encrypted and healthy | `encrypted` | `true` | `null` | Reads, writes, recovers. |
| No secure key, or storage unavailable | `ephemeral` | `false` | `null` | Works in memory. Writes nothing at all. |
| Damaged: bad tag, wrong key, corrupt, illegal record, closed | `encrypted` | `true` | the reason | Serves nothing. Writes nothing. |

Three rules in that table carry the weight:

- **The ephemeral port is not a fault.** Nothing was written, so nothing can have been lost,
  and `load()` returns `ok: true` with an empty snapshot. Reporting `degraded` there would
  invent a failure that did not happen. What it reports instead is `durable: false` and a
  sentence: *this machine has no secure Context key, so nothing is written to disk*.
- **There is no plaintext fallback.** Not a file, not a temp file, not an empty directory —
  there is no code path from the ephemeral port to a filesystem. The alternative would mean
  a person's selected paragraphs sitting where any backup or support bundle can read them,
  *with the appearance* of durability because a file did appear.
- **A damaged store is read-only, and that is load-bearing.** Reading stops at the first
  record that cannot be believed. Writing would be worse than either: a commit rewrites the
  file from what the store holds, so writing from a partial read would drop every record
  after the break, permanently and invisibly, and the next open would report the store
  healthy because the evidence is the thing just deleted. Refusing costs the owner the
  ability to share until they resolve the fault, which is visible; truncating costs them
  what they already shared, which is not (ARCHITECTURE §4.3).

---

## 5. An authenticated record is still checked against the domain

A valid tag proves **who wrote a record**. It never proves that the record is a legal
`ContextItem`. A bug in a future writer, a file assembled by hand from two valid records, or
a writer that had the key and wrote nonsense all produce records that authenticate
perfectly.

So `snapshot.ts` re-checks every recovered record against the domain's closed tables — the
kind must be a kind this build *sources* (a record claiming `active_window` or `agent_work`
is asserting a capability that does not exist), the scope must be a real scope, the
provenance must satisfy the same origin requirement admission enforces, the TTL must lie
inside the ceiling no matter which limits wrote it, the measurements must match the content,
and a revoked record must not still hold the content that revocation destroys.

The refusal is **total**. A store that served the records it could parse and dropped the
rest would make its contents a function of which records an attacker chose to damage, and
would present "we lost three items" as "there is nothing here". Every failure path ends the
same way: refuse the snapshot, say why in words, and let the caller hold an empty store that
reports itself degraded.

Each recovered record is also **rebuilt from named fields** rather than handed on as parsed,
so an unknown field in a file cannot survive a round trip. Subtraction by construction,
rather than filtering at a call site one refactor away from being forgotten.

---

## 6. A Context fault does not take down Core

`openContextPersistence()` never throws for anything a machine can do: a missing key, a key
of the wrong length, an unreadable file, a directory that is not a directory, a full disk.
Each produces an ephemeral port with the reason in words.

That is not leniency — it is the same judgement the Mission content store makes. Context is
the least load-bearing thing in Core: it holds no authority, no budget, no stop and no
decision. Letting a context-storage fault refuse to start would hand a disk error the power
to take down missions, cognition and conversation with it, which is exactly the failure the
issue names. The cost of degrading instead is that somebody's context does not survive the
restart: bounded, visible, and stated.

Structurally: nothing outside `core/context/persistence/` imports this directory, the lane
imports only the Context domain and Node's own `crypto`, `fs` and `path`, and there is no
`context.*` event type for a fault to be journalled into. A degraded store cannot reach
another subsystem even by accident, and it is not a security event — it cannot grant
anything and it does not lock Freya out either.

`EncryptedContextStore.open` still throws for a bad key length or an unusable path, so a host
that would rather refuse to run than run degraded keeps that option. `open.ts` is simply the
entry point that keeps Core alive.

---

## 7. Persisted Context still implies no authority

Nothing here grants, checks or widens anything. The strongest statement this lane can make is
that *a photograph survived a restart*, and a photograph is not a permit (Constitution C3 —
knowledge never implies permission).

- a `ContextSnapshot` record is a `ContextItem` and nothing more: no trust class, no
  capability, no "was authorised" flag, none of which the domain has vocabulary for and all
  of which a later reader would believe;
- the port has no method that grants, exports or decrypts by anything but an id the caller
  already holds, and no by-scope or by-provenance query — a generic read surface over private
  context would make "read the store" and "read all of this person's session" the same
  operation;
- Guard never reads this module, and this module imports nothing Guard could reach.

---

## 8. Private content reaches no generic surface

There are no `context.*` journal events, and this lane writes no envelope, no activity row
and no event id. Recovery reads one encrypted file and nothing else.

A refusal is a diagnostic, not a second channel for the thing it is diagnosing: a
record-too-large error names the record and the limit and zero characters of what was being
stored, and a damaged store reports a sentence about the *file*. Both are asserted with the
Red Team sentinel, so a diagnostic that grew a leak would fail a test rather than a review.

Zero idle inference is structural rather than claimed: there is no provider import, no
gateway, no completion call and no HTTP anywhere in the lane, so recovering context on
startup costs nothing at all. The single timer in the directory waits on a Windows rename
retry; there is no background job keeping context "fresh".

---

## Where the tests are

`tests/core/context/persistence/` — 70 tests, deterministic, offline, no model calls.

- **`context-persistence-crypto.test.ts`** — the bytes. The sentinel is absent from every
  byte of the file; the file holds no plaintext record fields; one file is written and
  nothing is left beside it; every rewrite gets a fresh nonce; no other domain's key opens
  this store and this store cannot open a Mission's; a record cannot be re-labelled, and a
  flipped bit is caught. Plus the "attacker or buggy writer who holds the key" cases: a
  record that authenticates and claims `active_window`, claims a TTL beyond the ceiling, or
  claims to be revoked while still holding its content, is refused by name.
- **`context-persistence-recovery.test.ts`** — the restart. Scope, provenance, TTL,
  measurements and revocation all come back byte-identical; an item that expired while the
  process was down is `expired` afterwards and its content is destroyed; a revoked item is
  `revoked` and stays revoked past its TTL; scope is the item's own; the current scope does
  not come back; purge and the retention bounds survive; recovery is deterministic and in the
  domain's own order.
- **`context-persistence-degraded.test.ts`** — the bad paths. No key, an unusable path, a
  wrong key, garbage on disk, a damaged record in the middle of the file, a closed store.
  Each ends in a stated state, a damaged store refuses to write, nothing is on disk when
  there is no key, and the port's own surface is asserted to be four fields and three
  methods.
- **`context-persistence-privacy.test.ts`** — the structural bounds, asserted against source
  with comments stripped: no authority-shaped field, no journal import, only Context-domain
  and Node imports, no clock, one timer, and no refusal that carries content.

---

## What this lane deliberately does not do

- **It does not wire anything into Core.** No `core/index.ts`, no facade, no projection. Issue
  #27 owns the assembly; this lane hands it a port and a health report.
- **It does not extend the keyring.** `electron/keyring.ts` owns the domain list, and adding
  a `context` domain there is Electron's decision in its own lane.
- **It does not build a durable `ContextStore`.** It persists what the domain produces and
  refuses what it would not produce. Hydrating a store, setting a current scope and deciding
  when to commit are the facade's, and doing them here would have meant two admission
  implementations that can drift.
- **It does not persist the current scope**, for the reason in §3.
- **It does not journal anything**, and it adds no `context.*` event. Audit surface stays
  where it is: metadata only, via the domain's own `ContextAuditRecord`.
- **It does not repair a damaged store.** No salvage, no skip-the-rest, no "recovered N of M".
  A file that cannot be believed is refused in full, and the reason is shown to a person.

## A note on an unrelated flaky test

`tests/core/work.test.ts > clears its deadline timer once a run settles` arms a 25 ms
deadline and sleeps 120 ms to prove nothing fires afterwards. On a loaded machine it is
marginal, and adding test files to the suite is enough to tip it: it failed roughly one full
run in four with this lane's four files present, and was clean across six full runs without
them. It passes in isolation, and it does not touch context. It is called out here rather than
quietly patched, because the fix belongs to the test that owns the timing.