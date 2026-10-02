# Phase 16 — Relay

Email, calendar, GitHub and external connectors through **bounded capabilities**
rather than raw account access. Relay is a capability-gated transport and control
plane: it is not a credential vault, and it is not a model-controlled account
bridge.

The governing rule is the one in [PRODUCT.md](PRODUCT.md): *models decide, code
controls*. Relay is the subsystem where that rule is easiest to violate — a
"connect Freya to everything" feature naturally drifts toward handing a model an
API key — so Phase 16 is written the other way: every action is separately
bounded, every write needs an explicit owner approval, and the only place a
credential can exist is inside an adapter the host constructed in the main
process.

## Core ownership

`core/relay/` is Core's, and it is Electron-free and renderer-free.

| File | Owns |
| --- | --- |
| `types.ts` | The closed vocabularies — connectors, actions, statuses, risk, failure codes, limits. |
| `validation.ts` | Strict normalization of addresses, repo refs, recipients, attachments, pagination and payload sizes. |
| `adapters.ts` | The narrow adapter ports and the deterministic offline fakes. |
| `state.ts` | The fold of `relay.*` events — actions, approvals, idempotency keys, budget instants. |
| `engine.ts` | The one impure piece: gates, idempotency, retry, approval, adapter calls, journal appends. |
| `projection.ts` | The only route from domain facts to a window. |

The engine holds no gateway, no authority object and no provider. It cannot spend
a model call, mint a capability or clear STOP ALL, because none of those exists on
any type it holds. That is asserted structurally by a red-team test that checks
the worker authority object has no relay method.

## The capability model

Every action is separately bounded — one capability per action:

```
relay.email.read          relay.email.draft       relay.email.send
relay.calendar.read        relay.calendar.create   relay.calendar.update
relay.calendar.cancel      relay.github.read       relay.github.issue.create
relay.github.pr.create     relay.external.invoke  relay.approval.decide
relay.status.read
```

Read access never implies write access. `relay.email.read` does not imply
`relay.email.send`; a principal holding every read capability and no write
capability can read and nothing else. `relay.approval.decide` is separate from
every action capability because it is the one Relay capability that means *a
person is being trusted* with an effect that leaves the building.

None of these is a grant a model or a worker can obtain. They are held by the
owner principal only, and `WORKER_CAPABILITIES` deliberately adds none of them.

## The gate order

Every action — read or write — passes through the same gates, in the same order,
each checked fresh:

1. **STOP ALL** — a stopped Core does not reach a connector, read or write.
2. **Guard** — the action's capability is evaluated against the owner principal.
3. **Connector availability** — a connector with no adapter is `unavailable`.
4. **Budget** — the durable rate ledger (see below).
5. **Validation** — the payload is normalized and bounded.
6. **Idempotency** — a replayed write returns the original outcome.
7. **Approval** — a write creates a pending approval and stops.

Reads execute directly under gates 1–5. Writes create a pending approval and
execute only after the owner decides.

## The budget ledger

Relay's Governor is a durable rate ledger derived from `relay.*` events:

- **Per-connector action cap** — 100 actions per connector per rolling hour,
  reads included. A read storm is still a storm.
- **Send cap** — 10 sends per rolling hour, across connectors.
- **Draft cap** — 20 drafts per rolling hour.
- **External invoke cap** — 25 invocations per rolling hour.
- **Pending approval cap** — 32 approvals pending at once.

Every figure is derived from the journal, so a restart cannot reset a budget —
the same honesty the attention fold applies to its own windows.

## Approval

A write request creates a pending approval and returns without touching the
adapter. The approval is single-use: a decided approval is never re-decided, and
an approval recovered from the journal after a restart is **expired** rather
than fired without its content — the same honesty attention applies to a schedule
whose text is gone.

The approval summary is a bounded sentence Core wrote from the request's
*targets* — who will be affected and what will happen. It never carries content:
no subject, no body, no title. The owner decides on the strength of the target
and the action, which is what an approval is for.

## Idempotency and replay protection

Every write carries a client-generated `idempotencyKey`. The fold remembers it,
so a replay returns the original outcome instead of performing the action twice.
A replayed send is not a second send. A replayed failed send does not retry. The
key store is bounded to the most recent 1024 keys, which is documented rather
than hidden.

## Retry policy

A transient adapter failure is retried at most `maxRetries` (2) times, and the
count is recorded in the journal. A non-transient failure is never retried.
Either way the action settles once: there is no loop, and a retry is never a
silent second attempt.

## Connector safety

### Email

Recipients, subject, body and attachment metadata are separated. There is no
BCC field — a hidden recipient is a recipient the approver cannot see. The
recipient list is deduplicated and bounded, so a payload cannot widen itself by
repeating an address. A draft is never a send: the two are different actions on
different capabilities.

### Calendar

Create, update and cancel are distinct actions. Timezone validation is instant
validation — a value that does not parse as an ISO-8601 instant is refused. The
attendee list is exactly what the caller supplied; the adapter receives it
verbatim. There is no silent invite expansion.

### GitHub

Repo allowlists are code-owned and host-supplied; empty means no repo may be
written to. Issue and PR creation are separate actions. A PR creation targets
two distinct branches and creates only a PR ref — there is no force-push, no
history rewrite, no branch deletion and no arbitrary command execution anywhere
in the vocabulary.

### External

The generic pattern is one action (`relay.external.invoke`) over named external
connectors the host registers. Registering a new external connector widens
nothing — the caller still needs the capability, an approval and a budget,
exactly as for a built-in connector.

## Privacy

Message, event and repo content stays in bounded result channels and is
minimized in the journal, the activity feed and projections. The journal holds
ids, closed labels, counts, instants and targets — never a message body, an
event title, an issue's text or a credential. The projection has no field any
of them could occupy. Content crosses back to a caller only through the bounded
result of the command that asked.

## Attention integration

Connector signals integrate with attention only through the authorized Phase 12
source seams. A read that returns results delivers a fixed-text signal
("The email connector reported new mail.") with source `system`. The text is a
fixed sentence Core wrote — never anything a connector returned. The attention
engine still decides what the signal is worth: this delivery cannot mint an
importance, an urgency or an outcome. There is no new surveillance authority.

## Renderer

The Relay surface renders truthful connector availability, pending approvals and
action state. It cannot forge availability or authority: availability is Core's
report, printed verbatim, and a write request shows "awaiting approval" and
nothing else until Core says it settled. The preload bridge whitelists the Relay
commands and rebuilds each payload from named fields, so a window cannot attach
an ignored blob or smuggle a capability, a credential or a budget.

## Red team

The red-team suite attacks: forged connector state, token/secret leakage,
capability laundering, read→write escalation, recipient widening, duplicate
send/replay, calendar invite expansion, GitHub repo-scope escape, destructive
action smuggling, renderer forgery, stale approval reuse, retry storms, event
poisoning, model-call amplification, STOP ALL bypass and private-content leakage.
Every attack is a named test that asserts the invariant it tried to break.

## Verification

On 2026-10-02 the full verification gate passed: 2,885 tests (108 new for Phase
16), typecheck, lint, renderer/main/preload build, 190 desktop e2e checks and
`git diff --check`. No live connector, account or provider call is required by
any test.
