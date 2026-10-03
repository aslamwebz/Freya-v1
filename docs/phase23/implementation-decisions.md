# Phase 23 — Implementation Decisions

**Status:** INTEGRATED — the domain below is wired into Core on
`integration/phase23-runtime`. See `runtime-integration.md` for the wiring, the
nine places the journal vocabulary had to be extended to make it expressible, and
what is deliberately left unwired. This file records the decisions that were made
*inside* the domain, which the wiring did not revisit.

Every place where the preparation documents and the implementation disagreed, and
which one won. Written down because a silent resolution is indistinguishable from
never having noticed, and "the docs say X but the code does Y" is exactly the
thing a reviewer cannot afford to discover for themselves.

The code is `core/lifeloop/`. Its tests are `tests/core/lifeloop/`.

---

## 1. Filter order

**Preparation text** (`PHASE-23.md` §6.1, §6 pipeline): STOP ALL, then journal
integrity, then grant, then budget, then cooldown, then focus, then justified.

**Implemented** (`core/lifeloop/prefilter.ts`):

```
journal-not-trustworthy -> stop-all-active -> loop-disabled -> no-active-wake
  -> budget-exhausted -> grant-unavailable -> cooldown-active
  -> focus-blocks-escalation -> cognition-not-justified -> ceilings
```

**Decided this way because** `core/cognition/governor.ts` checks the journal
before the latch, and a log with a hole in it may have lost the very STOP ALL
that would have refused the call. A loop that trusted a corrupt journal's silence
about its own stop would be the worse failure.

Budget before grant is the same kind of reasoning: an exhausted budget is the
more specific answer, and no grant would have changed it.

Focus sits after cooldown and before the kind check, as written — it is a check
on what the loop decided to *do* with the wake, so it has to come after the
gates that decide whether the wake is real.

---

## 2. Where a focus suppression is recorded

**Preparation text** (`PHASE-23.md` §6.1 step 6): "Focus — if focused, suppress
interruption", with no indication of where that lands.

**Implemented**: in the filter, as the denial `focus-blocks-escalation`, and again
in `core/lifeloop/decide.ts` as `resolveEscalation`.

**Decided this way because** a check that is applied only at the point of use is
invisible to the journal. The filter's copy exists so the refusal is *recorded*;
the decide copy exists so the rule is enforced at the point it matters. Two
call-sites of one rule, one of them for the record, is not duplication — it is a
journal entry.

A suppressed `interrupt` becomes `do-nothing`, not `speak`. Speaking would be the
loop making a new decision, and deciding to speak is itself a cognition, which
needs a wake it has not had.

---

## 3. Approval

**Preparation text**: `PHASE-23.md` §7.4 lists `awaiting_approval` as a waiting
state; §9.1 says "Owner approval is required for consequential actions"; §9.2
lists five interruption sources and approval is not among them.

**Implemented**: `approval-required` is a sixth interruption source. It moves
every non-idle state to `WAIT` with `awaitingApproval: true`, and
`interruptionDeadlineType('approval-required')` returns `'approval'`.

**Decided this way because** `awaiting_approval` was never a tenth state — the
state table has nine, and `WAIT` holding an `approval` deadline is the same fact
with one fewer state to get wrong. It also explains why `DeadlineType` included
`'approval'` with no producer anywhere: the approval interruption is what was
missing, and the type was waiting for it.

Approval *parks* the loop rather than denying it. Denying would write "the owner
said no" into the journal, which is a different and unfalse claim.

`IDLE` is the one state it does not apply to: there is nothing waiting on an
approval in a loop that is not running.

---

## 4. Deadline expiry from `ACTING` and `VERIFYING`

**Preparation text**: `continuation-state-machine.md` §"deadline" says expiry
produces `STOP`. The same document's own transition table and
`docs/phase23/interfaces.md` say `DENY`.

**Implemented**: `DENY`.

**Decided this way because** two documents against one, and because `DENY` is
recoverable while `STOP` is the latch-adjacent terminal state. An expired
verification is a failed loop, not a stopped Freya. `STOP` is reserved for STOP
ALL and for a loop that finished.

---

## 5. Terminal states

**Preparation text**: `PHASE-23.md` §7.3 calls `IDLE` terminal;
`continuation-state-machine.md` does not.

**Implemented**: `TERMINAL_STATES = ['DENY', 'STOP']`. `IDLE` is not terminal —
it is the resting state the loop returns to, and marking it terminal would mean
the loop has no state to wake into.

`DENY` and `STOP` have no outgoing edge except an explicit `reset`, and the reset
is journaled (`lifeloop.reset`) so a denied loop can become available again. That
event did not exist in the preparation text and its absence made the loop
single-shot: one wake, one refusal, silence for ever.

---

## 6. The grant rule for provider contact

**Preparation text**: nothing said where the "no background reasoning" rule is
enforced, only that it must hold.

**Implemented**: at `model.request.started`, which is where a provider is actually
contacted and which carries `grantId`. A provider contact with a null grant is
legal in exactly one case: `origin: 'user'` **and** `cause: 'user_message'` on
the matching `cognition.requested`.

**Decided this way because** `cognition.requested` carries no grant and no
provider by design — authorization happens after it. An earlier draft of the
assertion read `background`/`grantId` off `cognition.requested`, which Core never
writes, so the exemption was unreachable and the rule was dead code. It also
mirrors `core/cognition/governor.ts:119` rather than restating it.

`origin: 'user'` alone is not enough. A `user`-origin request caused by
`explicit_review` is still Freya deciding to think on her own, and needs a wake.

---

## 7. The retry ceiling and what it counts

**Preparation text** (`PHASE-23.md` §8.1, §8.2): "max attempts per step: 3",
sourced from `WORK_LIMITS.maxAttemptsPerStep`.

**Implemented**: `attemptCount`, journaled, incremented by both
`lifeloop.action.failed` and `lifeloop.verification.failed`. It follows the *unit
of work*, not the wake: a new wake with the same `goalRef` continues the count, a
new goal starts a fresh budget, and the close-out (`lifeloop.reset`) preserves
it.

**Decided this way because** a ceiling that resets per wake, or per restart, is
not a ceiling. A step that crashed the app on every attempt would otherwise be
tried three times per crash, for ever. The `unitRef` field exists for exactly
this: dropping it on close-out would let the budget reset once per attempt.

The numbers are re-declared in `LIFE_LOOP_LIMITS` rather than read from
`core/work/types.ts` so `core/lifeloop` keeps zero imports. They are equal today;
a test asserting that equality belongs at integration, where both modules are
visible.

---

## 8. Verification deadlines cannot be armed from an idle loop

**Preparation text**: nothing; the fold simply applied `lifeloop.verification.
started` wherever it appeared.

**Implemented**: the fold reports an `illegal-transition` anomaly and arms
nothing unless the loop is in `VERIFYING`. A payload that names no
`deadlineType` no longer clears a deadline the loop already holds.

**Decided this way because** a life-loop timer attached to a loop with no work is
the shape a self-running timer takes, and the second half is a terse payload
silently making a verifying loop unbounded.

---

## 9. Transitions: 16 or 19

`docs/phase23/interfaces.md` enumerated sixteen. The implementation carries
nineteen. The three extra are `deadline-expired` from `WAKING`, `ACTING` and
`VERIFYING` — the states that hold a deadline and must be interruptible when it
passes. An unwatched deadline is not a deadline.

---

## 10. `unknown-state`

`interrupt()` used to report `terminal` for a state that is not in the
continuation set. It now reports `unknown-state`. They mean opposite things, and
conflating them lets a corrupt journal entry read as a loop that finished its
work.

---

## 11. Two self-transitions in the interruption table

The table overrides the ordinary one, and it permits exactly two arrivals that do
not change the state:

- `WAKING --owner-command--> WAKING` — the loop is already serving the owner.
- `WAIT --approval-required--> WAIT` — already parked on an unanswered approval.

The second is new. Resetting the deadline on a second approval request would
restart the clock on a person who has already been waiting.