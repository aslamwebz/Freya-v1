# Cognition policy

How Freya decides whether to think, and what stops anything from deciding for
itself.

This document describes Phase 1. Where a rule is described as "structural", it
means the type system or the module graph enforces it, not that a reviewer is
trusted to notice.

---

## The one-sentence version

A model call happens only when the Governor allows it, the Governor allows it
only for a named principal acting on a closed vocabulary of intents, and
anything with a budget spends that budget durably *before* it is called.

---

## 1. Identity is assigned, never accepted

There is no `actor` parameter on any public method. Identity is a property of
the object a call arrives on, and Core builds those objects.

```ts
// core/authority.ts
interface OwnerAuthority {
  readonly principalId: 'owner'
  request(intent: CognitionIntent): Promise<CognitionOutcome>
  createGrant(spec: CognitionGrantSpec): Promise<unknown>
  revokeGrant(grantId: string, reason: string): Promise<boolean>
  grants(): readonly CognitionGrant[]
}

interface WorkerAuthority {
  readonly principalId: string
  request(intent: WorkerIntent): Promise<CognitionOutcome>   // no grant methods
}
```

What this buys, concretely:

| Attempt | What happens |
| --- | --- |
| `createGrant({ createdBy: 'owner' })` | `CognitionGrantSpec` has no such field. The recorded author is the principal the call arrived as. |
| a worker calling `createGrant` | No such method on `WorkerAuthority`. |
| a worker presenting `origin: 'user'` | `origin` is not a field on any intent. |
| a worker presenting `kind: 'user_turn'` | Not in `WorkerIntent`. The compiler rejects it, and `requestFor` refuses it again at runtime. |
| a worker naming itself `'owner'` | Its principal id is set by the caller of `workerAuthority`, and a worker is never `trusted`, so Guard refuses on trust before it reads capabilities. |

**There is one exported way to obtain an authority object, and it is not
exported from Core.** `core/testing.ts` reaches it through a single cast, and
that file is the only place in the repository that does. A future agent or
module is written *inside* `core/` and is handed an authority by Core.

### Where trusted principals are built

`core/security/guard.ts` exports no principal factory. It exports the *policy*
that judges a principal it is handed, and nothing that mints one. Trusted
principals are constructed in exactly one place: `CognitionService`.

This was a real hole. An earlier version exported `ownerPrincipal(capabilities)`
from the guard module, so any Core module could call it and be the owner in code
that read like ordinary use of the security module. A `Principal` is still a
plain interface and a determined caller can write the literal — what is gone is
the official-looking constructor, which is the difference between an escalation
that looks normal and one that does not.

---

## 2. Intents are a closed vocabulary, not a composition

A caller says *what kind* of cognition this is. Core derives the origin, the
cause, and whether it is background:

| Intent kind | Origin | Cause | Background | Needs a grant |
| --- | --- | --- | --- | --- |
| `user_turn` | `user` | `user_message` | no | no — the only grantless path |
| `agent_step` | `agent` | `run_finished` | yes | yes |
| `scheduled_task` | `system` | `scheduled_grant` | yes | yes, and it must permit background |

A caller cannot compose an origin and a cause into a combination that is more
powerful than either part, because it never supplies either.

`user_turn` is defined as *a human being present*, not as a claim. It is
reachable only from the owner's authority, and the worker's request type does
not include it.

---

## 3. Grants are finite, and a division of a finite allowance

A grant carries hard ceilings on calls and on output tokens, an expiry, and a
scope. There is no "unlimited" and no "until further notice".

- `maxCalls` and `maxOutputTokens` must be positive integers.
- `expiresAt` must be in the future at creation.
- `parentGrantId` exists so that splitting a grant is a **division of the
  parent's remaining allowance**, never a fresh allocation.

Grant creation and revocation require `cognition.grant.manage`, which only the
owner holds, and the check is a Guard evaluation — not a hardcoded role
comparison. A refused attempt is written to the log as a `guard.decision`.

From outside Core, grant governance is a **command**. The handler records the
owner as the author regardless of what the payload claims, and the payload has
no field that could change that.

---

## 4. The token budget is reserved before the call, and never refunded

This is the part that is easy to get wrong, so it is worth being precise.

There are two different quantities, and they are separate fields on purpose:

- **`outputTokenBudgetReserved`** — authorisation arithmetic. The allowance taken
  out of the grant's budget *before* the provider is called. It moves whether or
  not the call succeeds, whether or not the provider ever answers, and it
  survives a crash.
- **`outputTokens`** — reported usage. What the provider said it consumed. It
  stays `null` when the provider says nothing.

A worked example. A grant with 1000 tokens, and a request for 300:

```
  durable reservation        = 300
  remaining after            = 700
  provider may now be called
```

The allowance is gone the moment the reservation is durable, whether the
provider then returns 12 tokens, returns nothing, fails, or the process dies
mid-flight. **A crash or a missing usage report must never refund it**, because
a refund is how a budget silently becomes unlimited.

Reported usage is recorded afterwards and separately. It never moves the budget.
If it did, a provider reporting less than it was allowed would hand the
difference back, and a provider reporting nothing at all would be free.

### Reported usage accumulates, and is never a total on its own

`outputTokenBudgetReserved` is authorisation arithmetic. The provider's report is
a different quantity and is tracked separately, with one rule that the earlier
version got wrong: **a report is added to the running total, never substituted
for it.**

```ts
usage = {
  calls: 2,
  inputTokens: 30,          // sum of what the two calls reported
  outputTokens: 30,
  unknownUsageCalls: 0,     // calls that reported nothing, or only part of it
}
```

`unknownUsageCalls` is the explicit representation of "we do not know", chosen
over the two alternatives:

- **treating an unreported call as zero** would make an unaccounted call look
  like a free one, and would silently refund real spend;
- **making the whole total `null` if any call was unknown** would throw away the
  calls that *were* accounted for, which is information too.

So the totals are a **declared lower bound** whenever `unknownUsageCalls` is
above zero, and any caller presenting them as exact must check it first. Nothing
is ever estimated.

This is entirely independent of the authorisation budget: a provider reporting
one token does not buy back the 300 it was authorised to use.

### Reaching a provider and failing is not free

A provider that was reached and then failed has almost certainly consumed
inference. A timeout is billed, and a stream that dies mid-answer was billed for
every token it emitted. Recording nothing for such a call would report a paid
request as a free one — the same error as treating an unreported *success* as
zero.

So the outcomes are:

| Outcome | `calls` | reported totals | `unknownUsageCalls` |
| --- | --- | --- | --- |
| no provider selected or contacted | 0 | — | 0 |
| reached, completed, fully reported | +1 | accumulate | unchanged |
| reached, completed, not fully reported | +1 | accumulate what is known | +1 |
| **reached, then failed** | **+1** | **unchanged** | **+1** |

The distinction between the first and last rows is the one that is easy to get
wrong, and it is not carried by a provider's name. It is carried twice, by two
independent mechanisms, because the two accounting paths replay at different
times:

- **Durable accounting** replays the journal, so it compares the
  `model.request.failed` against the `model.request.started` for that request.
- **The grant, live** is told by the gateway itself, which tags every error it
  throws with `providerContacted`. A request that found no provider is tagged
  `false`, so the grant records no gap; anything unrecognised is treated as
  contacted, because the cost of guessing the other way is a paid request
  recorded as free.

Neither path looks at `providerId`, `kind`, or whether the name sounds live.

The **authorisation reservation is unaffected by all of this.** A grant that was
never used because no provider existed still shows its call and its output
allowance as spent: authorisation is charged before any provider is consulted,
and a failure — or an absent provider — is not a refund.

This holds in all three places that count: the gateway's session usage, the
durable usage recovered by replaying the journal, and the grant's reported
usage. The reservation is untouched by all of it — a failed call's authorised
output allowance stays spent, because authorisation is not refunded because the
provider misbehaved.

### Authorisation and reservation are one indivisible step

They used to be two, and that was a hole in the budget. Ten concurrent requests
of 300 tokens against a 1000-token grant were all allowed, and the grant
finished 3000 tokens over: every caller read the same remaining figure before
any of them had reserved.

Serialising the event log does not fix this. The fabric guarantees unique
sequences, not a correct decision. The fix is a lock **per grant**, held across
the Governor's evaluation and the reservation, released before the provider is
called so that inference is not serialised. Different grants proceed in
parallel.

---

## 5. STOP ALL outranks everything

`security.stopAll` is a latch, not a flag, and it is **derived from the event
log** rather than stored — so it survives a restart, and a new Core over the
same log finds it already set. A store that merely remembered the previous run
would get this wrong.

The Governor checks it before anything else, including before a valid grant.
While it is set, every request is denied and no provider is constructed.

Only the owner can clear it, and clearing it is its own capability
(`security.resume`), separate from stopping.

In the UI, stopping takes two deliberate presses: the first arms, the second
confirms, and the armed state expires on its own after a few seconds. The latch
is durable, so a misclick would not have worn off.

---

## 6. A model has no path to authority

There is no capability in the vocabulary that lets a principal create, extend or
revoke a grant. There is no path from a provider response back into the
authority layer, and no code parses a provider's text.

A provider reply becomes a `text` field and nothing else. This is asserted, not
assumed: a test returns provider text that is valid JSON shaped like a grant
spec with an enormous budget, and checks that the grant's ceilings are unchanged
and that exactly one grant event exists.

---

## 7. Zero idle spend

Nothing in Core causes a provider call without a request that asked for one:

- starting Core, replaying the log, reading status, subscribing, a renderer
  reload, a window closing, a workspace flush — none of these calls a provider.
- a rejected command does not reach a provider, and does not construct one.
- an *unauthorised* request fails with `no configured provider can serve this
  request`, which is a different answer from a policy denial, and says so.

### The echo provider is not a model

`FakeModelProvider` returns your prompt back. Production registers **NanoGPT
and nothing else**: if it is absent or disabled there is no configured provider,
and a request fails with that reason rather than falling back to something that
would look like a working assistant.

The echo provider is opt-in under `developerEchoProvider`, is listed last so it
cannot shadow a real provider, and prefixes its output so a screenshot cannot be
mistaken for a reply.

---

## Where the tests for all of this are

| Claim | Test |
| --- | --- |
| A caller cannot assert identity | `tests/core/authority.test.ts` |
| No principal factory is exported | `tests/core/adversarial.test.ts` |
| Concurrent requests cannot overrun a budget | `tests/core/adversarial.test.ts` |
| A crash does not refund a reservation | `tests/core/cognition.test.ts` |
| Unreported usage is not free budget | `tests/core/cognition.test.ts` |
| A budget survives a restart | `tests/core/cognition.test.ts` |
| A worker cannot reach the user path | `tests/core/authority.test.ts` |
| Provider text changes nothing | `tests/core/authority.test.ts` |
| A denied request touches no provider | `tests/core/cognition.test.ts` |
| A window cannot name grant commands | `tests/host/coreHost.test.ts` |
| STOP ALL survives a relaunch | `tests/e2e/desktop.e2e.ts` |
