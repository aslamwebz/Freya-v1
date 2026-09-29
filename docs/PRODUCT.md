# Freya

**A secure, voice-first personal intelligence environment, centred on one
persistent intelligence, with transparent work surfaces.**

The user talks to Freya. Everything else in the product is machinery in service
of that single relationship.

---

## What the user experiences

One command centre. Freya's intelligence sits at the optical centre. Around it,
the state that matters: what Freya is focused on, what it is working on, what it
needs from the user, and what its workforce is doing.

Work happens in **detachable glass surfaces** — chat, search, research, a
mission, a browser, a vault, a terminal, an agent room, a swarm room, a foundry.
They are movable, resizable, dockable and persistent. They are windows in one
system, not modals bolted onto a page.

Voice is not a separate assistant. The same conversation serves text and
speech: microphone, local recognition, Freya, local synthesis. In this build
only the interaction boundary exists; no speech stack is installed.

---

## First principles

1. **One intelligence, many surfaces.** The user should not have to learn which
   of several assistants they are talking to. Agents are internal workforce, not
   separate products.
2. **Models decide. Code controls. Events remember. Verification establishes
   truth. Presence communicates state.** Judgment goes to a model; repetition,
   policy and enforcement go to code.
3. **AI for judgment, code for repetition.** Use a model where the answer is
   not known in advance. Do not pay for inference to run a loop.
4. **Intelligence, autonomy and compute are separate axes.** How capable Freya
   is, what it may do without asking, and how much inference it may consume are
   three independent controls. A more capable model is not a licence to act
   freely; more autonomy is not a licence to spend more.
5. **Continuously aware, not continuously running an LLM.** Awareness is
   structural: state, events, and retrieval. Cognition is invoked only when
   there is authorized cognitive work to do.
6. **Idle Freya costs nothing.** With no authorized cognitive work outstanding,
   Freya consumes zero paid model inference. This is a design constraint, not an
   optimisation to be added later.

---

## The canonical execution model

Every kind of long work converges on one structure:

```
Mission → Run → Step → Action → Observation → Verification
```

Chat, research, an agent, a swarm, a browser session, a workflow, a terminal
command, a module build and a learning cycle all use this same structure.
Verification is not optional: an action is not evidence that it worked.

Phase 0 documents this boundary. It does not implement this engine.

---

## Security direction

```
Identity → Capability → Scope → Policy → Risk → Approval → Action → Audit
```

Future modules and agents **receive capabilities**. They never inherit
unrestricted system access. A model must never be able to grant itself more
permission, a larger budget, a secret, approval bypass, unrestricted terminal
access, or a change to security policy. Approval is a first-class outcome, and
Freya asks before consequential actions rather than after.

Phase 0 establishes the process boundary that this will be enforced across. It
does not build the security engine.

---

## Knowledge model

Freya distinguishes six stores, and the distinction is load-bearing:

| Store | Holds |
| --- | --- |
| **Vault** | human-readable durable knowledge, Obsidian-compatible |
| **Memory** | personal and contextual facts |
| **World** | current, changing state |
| **History** | what happened |
| **Experience** | how previous work performed |
| **Skills** | procedures that proved useful |

The Vault is not the brain. It is the part a human reads.

---

## Future systems

**None of the following is implemented.** They are listed so the Phase 0
architecture can be checked against them.

| System | Will own |
| --- | --- |
| **Core** | runtime, state, event fabric, RPC, lifecycle |
| **Mind** | main intelligence, conversation, planning, executive cognition |
| **Governor** | cognition authority, budgets, autonomy |
| **Searcher** | local files, vault, semantic and full-text retrieval, web research, evidence |
| **Vault** | durable knowledge, Obsidian-compatible storage, secure access |
| **Work** | runs, tasks, approvals, board |
| **Missions** | persistent outcomes |
| **Workforce** | agents, teams, swarms |
| **Harness** | terminals, browsers, agent sessions, execution environments |
| **Foundry** | artifacts, tools, reusable modules, applications Freya builds |
| **Relay** | messaging and external connectors |
| **Guard** | identity, permissions, secrets, approvals, audit |
| **Presence** | voice, visual intelligence state, sound |
| **Office** | a future 3D representation of the same live system state |

Office is not a separate application. It is another presentation of the same
live state, which is why state and presentation are separated in this codebase.

---

## What Phase 0 is

A real desktop shell: one command centre, one presence, one reusable surface
manager, local layout persistence, a typed event model, and a test suite. It
runs, it is testable, and it is honest about the fact that there is no AI
behind it yet.
