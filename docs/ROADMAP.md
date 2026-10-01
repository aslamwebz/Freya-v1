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

## Phase 7 — Missions

Persistent outcomes above Runs. Durable Mission identity/intent/outcome, strict
states, child Runs through `Run.parent`, truthful progress, verified completion,
budgets, pause/cancel propagation and a read-only projection.

No Workforce or computer control yet.

## Phase 8 — Workforce

Named subordinate agents such as Alpha/Beta, specialization, teams, bounded
concurrency, per-worker capability/context assignment, budgets and agent messaging.
Agent permission claims are not authority.

## Phase 9 — Context Awareness

Resolve natural references such as "this" and "here" from permissioned,
provenance-carrying context: active app/window metadata, explicit selection,
authorized project/file, shared tab/media, current Mission and active agent work.
Every context item has scope, TTL and revocation.

No omniscient global screen privilege.

## Phase 10 — Harness and Computer Hands

Bounded capability families for Browser, Files, Editor, Apps, Computer and
controlled Terminal. Every action passes Guard and produces Observation/
Verification. The local device broker remains the final authority boundary.

## Phase 11 — Personality and Relationship

Stable identity/temperament, relationship state, social interpretation before
response, expression planning, bounded expression memory, anti-repetition,
relationship habits/inside jokes and model-independent personality evaluation.

The Constitution remains above personality.

## Phase 12 — Events and Attention

Authorized event ingestion, importance/urgency, interruption budgets, cooldown,
focus awareness, scheduled/conditional attention and outcomes: remember, subtle
cue, speak or interrupt. "Do nothing" is a valid outcome.

## Phase 13 — Desktop Presence

Prototype with Electron/Three.js first: transparent frameless character window,
dragging, click-through, animations, voice, contextual cards, monitor placement
and dashboard transitions.

Presence consumes a platform-neutral protocol so a future native/Godot renderer can
replace it without moving Core.

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
