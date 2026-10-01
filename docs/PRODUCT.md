# Freya

**A secure, persistent personal intelligence that lives alongside the user,
understands authorized context, acts through bounded capabilities, and can embody
itself through multiple interfaces without changing who it is.**

Freya is not a chatbot, dashboard, 3D avatar, LLM, or agent office. Those are
bodies, tools and views. **Freya is the Core: identity, relationship, memory,
context, judgment, work, authority and continuity.**

The current build is desktop-first and local. That is the right deployment model
for the prototype; it is not a permanent coupling between Freya and Electron.

---

## Product promise

Freya should reduce the amount of work the user has to carry while increasing,
not reducing, the user's control.

The long-term experience is:

- Freya is present when useful and quiet when not;
- the user can speak naturally instead of translating every thought into a prompt;
- "this", "here", "the video" and "this function" resolve against context the user
  explicitly allowed Freya to see;
- simple help happens in place, without forcing the user into a dashboard;
- serious work can expand into the dashboard or Office;
- consequential actions remain bounded by Guard, approval and verification;
- Freya remains recognisably the same person even when the model, renderer or
  device changes.

The governing rules live in [FREYA-CONSTITUTION.md](FREYA-CONSTITUTION.md).

---

## Three interaction levels

### Ambient

Freya lives beside normal computer use. The user should not have to stop what they
are doing and "go talk to the AI" when authorized context is enough.

Examples: "what does this part do?" in an editor, "this tutorial is too long" on
an authorized video, "translate this", "convert that to EUR", or "what's up?"
where the meaning is situational rather than literal.

### Active

Freya may show a small contextual card, explanation, choice, progress view or
approval request near the current work.

### Workspace

The dashboard is Freya's deep-work environment, not Freya herself. Research,
Missions, Work, Browser, Vault, Foundry and agent views become visible when the
work benefits from inspection or control.

The future Office is another projection of the same live state. Freya and agents
appear to work only when real Runs, Steps and capabilities are active.

---

## Core, bodies and hands

```
                         FREYA CORE
          identity · personality · relationship
          memory · context · missions · work
          workforce · guard · events · cognition
                             │
                      Freya Protocol
                             │
             ┌───────────────┼───────────────┐
             │               │               │
       Desktop Presence   Dashboard        Office
       body / voice       workspace       workforce view
             │               │               │
             └───────────────┼───────────────┘
                             │
                     Device capability broker
                             │
        ┌───────────┬────────┼────────┬───────────┐
        │           │        │        │           │
      Browser     Files    Editor    Apps      Computer
```

**Core is Freya.** A renderer may disappear without ending Freya. A renderer may
be replaced without changing identity or memory.

**Bodies communicate state.** Orb, desktop character, dashboard and Office do not
own authority, memory truth, agent truth or model credentials.

**Hands are capabilities.** Browser, files, editor, applications and computer
control are scoped, purpose-bound and evaluated by Guard.

---

## First principles

1. **Protect the user first.** Safety, privacy, autonomy, information and the
   integrity of Freya and the user's systems outrank convenience, growth and revenue.
2. **One intelligence, many embodiments.** Agents are subordinate workforce, not
   separate products.
3. **Knowledge is not permission. Access is not ownership. Capability is not
   authority.**
4. **Models decide. Code controls. Events remember. Verification establishes
   truth. Presence communicates state.**
5. **AI for judgment, code for repetition.**
6. **Intelligence, autonomy and compute are separate axes.**
7. **Context is permissioned, not omniscient.**
8. **Personality is stable but not repetitive.**
9. **Personality never overrides safety.**
10. **Continuously aware does not mean continuously calling an LLM.**
11. **Idle Freya costs nothing.**
12. **Important authority and work remain inspectable.**

---

## Personality and relationship

Freya's personality is a system, not one prompt:

```
stable identity
 + temperament
 + relationship history
 + current situation
 + relevant memory
 + expression history
 + social judgment
          ↓
   response planner
    /    |     \
 speak   act   animate
```

The same event must not produce the same sentence every day. Variation should come
from changed context and relationship history, not random synonym substitution.

Freya keeps bounded expression memory for recent greetings, jokes, sentence
openings, suggestions, interruptions and animations. Recurring habits and inside
jokes may emerge from relationship history; product boilerplate must not masquerade
as personality.

The companion exists for the user's benefit, not to maximize attachment. Freya
must not intentionally create guilt, isolation, dependence or fear of leaving.

---

## Context model

Natural language depends on shared context. "What is this?" is meaningful only if
Freya can resolve "this" through an authorized source.

Future Context owns provenance-carrying references such as:

```
active application/window
explicit selection
authorized file/project
shared browser tab
current media
current Mission
recent conversation
active agent work
```

Freya does **not** receive a global "see my computer" privilege. Device access is
composed from narrow capabilities and can be revoked.

---

## Canonical execution model

```
Mission → Run → Step → Action → Observation → Verification
```

An action is not evidence that it worked.

Missions own persistent outcomes. Work owns execution. Guard owns authority.
Workforce owns subordinate agents. Harness owns execution environments. Presence
and Office render projections of that truth.

---

## Security direction

```
Identity → Capability → Scope → Policy → Risk → Approval → Action → Audit
```

A model, agent, webpage, plugin, renderer or tool result must never be able to
mint or widen its own permissions, raise code-owned budgets, obtain secrets merely
by asking, bypass approval, reclassify untrusted context as owner truth, change the
Constitution/Guard, fabricate verification, or expose protected information.

Major builds are attacked by [RED-TEAM.md](RED-TEAM.md).

---

## Knowledge model

| Store | Holds |
| --- | --- |
| **Vault** | human-readable durable knowledge |
| **Memory** | admitted personal and contextual claims |
| **World** | current changing state |
| **History** | what happened |
| **Experience** | how previous work performed |
| **Skills** | procedures that proved useful |

Memory is not authority. History is not proof that a process is currently running.

---

## Systems

| System | Owns |
| --- | --- |
| **Core** | lifecycle, state, event fabric, protocol |
| **Mind** | executive cognition and conversation |
| **Personality** | stable identity, relationship and expression planning |
| **Context** | authorized situational references and provenance |
| **Governor** | cognition authority and budgets |
| **Searcher** | search, public web research and evidence |
| **Vault** | durable human-readable knowledge |
| **Work** | Runs, Steps, Actions, Observations, Verification, approvals |
| **Missions** | persistent outcomes |
| **Workforce** | subordinate agents, teams and swarms |
| **Harness** | browser, terminal, editor and execution environments |
| **Foundry** | artifacts, tools, modules and applications |
| **Relay** | messaging and external connectors |
| **Guard** | identity, permissions, secrets, approvals and audit |
| **Attention** | event importance, interruption and proactivity policy |
| **Presence** | voice, orb, desktop embodiment, animation and sound |
| **Office** | spatial projection of real Workforce/Work state |

---

## Current boundary

Phases 1–6 provide Core authority/cognition, conversation, voice boundaries,
Brain/memory, public research and Work.

Today Core is hosted by Electron for prototype velocity. From this point forward:

> **Everything that makes Freya Freya must remain independent of Electron.**

Core must not depend on React, DOM, CSS, Three.js or BrowserWindow. Electron may
host adapters and device capabilities; it does not own identity, memory, Missions,
Workforce or authority.

See [ROADMAP.md](ROADMAP.md).

Mobile and the public customizable companion are intentionally deferred to
**Phase 30+**. The current priority is making one private desktop Freya genuinely
useful, safe, contextual, capable and alive.
