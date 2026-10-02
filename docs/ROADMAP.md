# Freya roadmap

This roadmap keeps the completed Phase 1–6 foundation and changes the future from
dashboard-centric software into a persistent embodied personal intelligence.

Mobile and the public companion are deliberately deferred.

---

## Completed foundation

- **Phase 1 — Core authority/cognition:** identity, Guard, Governor, budgets,
  model gateway, STOP ALL and event boundaries.
- **Phase 2 — Voice boundary/Presence:** local voice seam and honest presence.
- **Phase 3 — Conversation/Identity:** encrypted conversation, Mind and Identity.
- **Phase 4 — Brain/Memory:** admitted memory, entities/relations, retrieval and
  encrypted Brain storage.
- **Phase 5 — Research:** Searcher, safe public transport, managed read-only browser,
  evidence and cited research.
- **Phase 6 — Work:** Run → Step → Action → Observation → Verification, Tasks,
  approvals, deadlines, cancellation and recovery.

---

## Phase 7 — Missions (done)

Persistent outcomes above Runs. Durable Mission identity/intent/outcome, strict
states, child Runs through `Run.parent`, truthful progress, verified completion,
budgets, pause/cancel propagation and a read-only projection.

What was built, and what was left out on purpose, is recorded in
[PHASE-7.md](PHASE-7.md). The short version: a Mission is a durable record of an
outcome, a bounded set of Runs you may attach to it, and a conclusion only a
code-owned verifier can make. Nothing decomposes a Mission into Runs by itself,
nothing plans, and nothing is ever concluded unattended.

No Workforce or computer control yet.

## Phase 8 — Workforce (Core landed)

Named subordinate agents such as Alpha/Beta with stable ids, specialization, teams, bounded
worker concurrency, per-worker capability/context assignment as Core-scoped claims,
per-worker budgets, bounded attributable agent messaging, and a deterministic read-only
projection.

**Agent permission claims are data, never authority** — enforced as a type rather than a
convention: a worker's scope has no method that grants anything, the only capability any
worker may hold is `cognition.request`, and a claim is refused and journalled with a
`decision` field that has exactly one legal value.

What was built, and what was left out on purpose, is recorded in
[PHASE-8.md](PHASE-8.md). The short version: this phase built the subordinates, not their
autonomy. Nothing decomposes a Mission into assignments, and no assignment executes. No
renderer, no protocol commands, and no host bridge yet — those are the integration lane.

No computer control yet.

## Phase 9 — Context Awareness

Resolve natural references such as "this" and "here" from permissioned,
provenance-carrying context: active app/window metadata, explicit selection,
authorized project/file, shared tab/media, current Mission and active agent work.
Every context item has scope, TTL and revocation.

No omniscient global screen privilege.

Phase 9 implementation and final acceptance gates are complete. Production
assembly connects encrypted Context restart recovery, actual conversation-scoped
Mind input and opt-in own-app window observation. The read-only desktop mirror
reports actual storage health. On 2026-10-02 the full verification gate passed:
2,089 tests, typecheck, lint, build and 187 desktop checks. [Issue #47](https://github.com/aslamwebz/Freya/issues/47)
tracks integration into `phase-7-missions`; `main` is preserved separately.
See [PHASE-9.md](PHASE-9.md) for ownership, provenance and verification details.

OS-wide native observation and `agent_work` remain explicit unsupported/deferred
boundaries; no Phase 10 execution is included.

## Phase 10 — Harness and Computer Hands

Bounded capability families for Browser, Files, Editor, Apps, Computer and
controlled Terminal. Every action passes Guard and produces Observation/
Verification. The local device broker remains the final authority boundary.

## Phase 11 — Personality and Relationship

Stable identity/temperament, relationship state, social interpretation before
response, expression planning, bounded expression memory, anti-repetition,
relationship habits/inside jokes and model-independent personality evaluation.

The Constitution remains above personality.

## Phase 12 — Events and Attention (Core landed)

Authorized event ingestion, code-owned importance/urgency, interruption budgets,
cooldown, focus awareness, scheduled/conditional attention and outcomes: remember,
subtle cue, speak or interrupt. "Do nothing" is a valid, well-tested outcome.

The score, the budget, the cooldown and the outcome are closed Core tables; an
event's text is data the policy never reads. Ingestion is only through authorized
sources, and a renderer cannot name its own source, set an importance, decide an
outcome, spend an interruption budget or drive the scheduler. No attention decision
can mint a capability, clear STOP ALL or reach a model.

What was built, and what was left out on purpose, is recorded in
[PHASE-12.md](PHASE-12.md). The short version: this phase built the attention
decision, not a notification centre with opinions. A native/connector event source
is Phase 16's Relay boundary; OS-wide focus sensing remains unsupported; and voice
delivery of `speak`/`interrupt` is a Presence concern, not this phase's.


## Phase 13 — Desktop Presence (done)

Transparent frameless presence window with click-through, bounded animations,
voice seam, contextual cards and monitor-aware placement. Presence consumes a
platform-neutral protocol so a future native/Godot renderer can replace it
without moving Core.

What was built, and what was left out on purpose, is recorded in
[PHASE-13.md](PHASE-13.md). The short version: this phase built the presence
presentation layer, not a synthetic character with feelings. A real synthesis
engine and a real transcription engine are future phases; thinking as a
distinct state is a future phase; a native/Godot renderer is a future phase.

## Phase 14 — Office

A truthful spatial view of real Work/Workforce state. Freya and agents work only
when actual Runs/Steps exist. The user can inspect, redirect and cancel. Agents may
join desktop Presence on request.

No decorative fake work.

## Phase 15 — Foundry

Artifacts, reusable tools, modules and applications built through Work/Harness with
verification and review.

## Phase 16 — Relay

Email, calendar, GitHub and external connectors through bounded capabilities rather
than raw account access.

## Phase 17 — Skills, evaluation and controlled improvement

Reusable procedures, outcome evaluation, skill promotion and bounded improvement.
Freya may improve ordinary implementation/procedures; she cannot rewrite the
Constitution, Guard or her own authority.

## Phase 18 — Integration, security and packaging

Service-separation readiness, signed builds/update path, supply-chain hardening,
backup/recovery, performance budgets, installer/startup behavior and full Gauntlet
release gate. Core may move to a separate local service here if the prototype proves
the need.

---

## Continuous track — Red Team Gauntlet

Security adversarial work starts now, not at Phase 18. Security-relevant changes get
smoke attacks; major phases/releases get the full Gauntlet. Every successful attack
becomes a permanent regression.

See [RED-TEAM.md](RED-TEAM.md).

---

## Phase 30+ — mobile and public companion

Explicitly out of current scope.

Possible later work: thin clients, hardened hosted Core, customizable names/
appearance/personality, device-local brokers, commercial tenant isolation and
privacy architecture.

Do not pull Phase 30 concerns into the private desktop prototype unless they affect
a boundary that would otherwise force a rewrite.

---

## Near-term prototype milestone

The prototype should prove one coherent story:

1. the user works normally;
2. Freya understands explicitly shared context;
3. a natural request becomes a Mission/Run;
4. she acts through bounded hands;
5. Guard asks only when needed;
6. verification proves the result;
7. personality makes it feel like Freya rather than a command runner;
8. "show me you work" opens the dashboard/Office view of the same real state.

That experience matters more than a long list of disconnected tools.
