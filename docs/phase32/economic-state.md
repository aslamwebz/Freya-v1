# Phase 32 — Explainable Economic State

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

The economic state is the answer to: what is being researched, what is
uncertain, what the evidence shows, and what is the next bounded action. It is
a projection, not a live handle. It is derived from durable state and is
always explainable.

The economic state is the primary interface between the economic subsystem and
the owner. It is what the owner sees and acts upon.

---

## 2. Design principles

### 2.1 Explainable

Every item in the economic state carries:
- What it is (id, kind, summary)
- Why it matters (reasoning, evidence)
- What is blocked (blocked reason)
- What is uncertain (uncertainty markers)
- What can be done next (next bounded action)

### 2.2 Deterministic

The economic state is derived from durable state using deterministic functions.
Same inputs + same clock = same state. This is testable and auditable.

### 2.3 Bounded

The economic state has:
- A maximum number of items in each list
- A maximum length for each string
- A maximum age for each item

### 2.4 Honest

The economic state never:
- Hides uncertainty
- Fabricates confidence
- Claims an outcome that has not been verified
- Shows a percentage that has no denominator
- Invents a mental or emotional state
- Claims a real-money action was performed

---

## 3. Economic state structure

### 3.1 Active experiments

A ranked list of economic experiments that need attention now.

Each item has:
- `experimentId`: the experiment's id
- `kind`: research, simulation, or paper-trading
- `state`: the experiment's state
- `title`: a bounded, human-readable title
- `progress`: how close the experiment is to completion
- `reasoning`: why this item matters (closed codes)
- `blockedReason`: why this item cannot proceed (null if not blocked)
- `uncertainty`: what is uncertain about this item

### 3.2 Blocked experiments

A list of experiments that cannot proceed due to a hard blocker.

Each item has:
- `experimentId`: the experiment's id
- `kind`: research, simulation, or paper-trading
- `state`: the experiment's state
- `title`: a bounded, human-readable title
- `blocker`: the type of blocker
- `reasoning`: why this item is blocked

### 3.3 Uncertain experiments

A list of experiments that have uncertain evidence, assumptions, or outcomes.

Each item has:
- `experimentId`: the experiment's id
- `kind`: research, simulation, or paper-trading
- `state`: the experiment's state
- `title`: a bounded, human-readable title
- `uncertainty`: what is uncertain
- `assumptions`: what assumptions are being made

### 3.4 Recent evidence

A bounded list of recently gathered evidence.

Each item has:
- `evidenceId`: the evidence's id
- `source`: the evidence's source
- `citation`: the evidence's citation
- `state`: the evidence's freshness/conflict state
- `confidence`: the evidence's confidence level

### 3.5 Next bounded action

The single next action the economic subsystem recommends.

The action has:
- `actionId`: a unique id
- `kind`: execute, delegate, verify, wait, escalate, or stop
- `target`: what the action targets
- `deadlineAt`: when the action must be completed
- `maxAttempts`: how many attempts are allowed
- `reasoning`: why this action is recommended

---

## 4. Uncertainty representation

### 4.1 Confidence levels

Every item carries a confidence level:

| Level | Meaning |
|---|---|
| `high` | Multiple independent sources agree |
| `medium` | Single reliable source |
| `low` | Single uncertain source |
| `unknown` | No source or conflicting sources |

### 4.2 Assumptions

When the economic subsystem makes an assumption, it is recorded:
- `assumptionId`: a unique id
- `statement`: what is assumed
- `confidence`: how confident the assumption is
- `source`: where the assumption came from
- `evidence`: what evidence supports the assumption
- `expiresAt`: when the assumption expires
- `reversible`: whether the assumption can be reversed

### 4.3 Stale evidence

When evidence is stale:
- It is marked as stale
- Its confidence is reduced
- The item is flagged
- The owner is notified if the staleness affects critical decisions

### 4.4 Conflicted evidence

When evidence is conflicted:
- Both versions are preserved
- The conflict is recorded
- The more conservative interpretation is used
- The owner is notified

---

## 5. Economic state lifecycle

### 5.1 Creation

The economic state is created when:
1. A wake event is received
2. The pre-cognition filter allows processing
3. The research engine gathers evidence
4. The simulation engine runs scenarios
5. The paper trading engine places orders

### 5.2 Update

The economic state is updated when:
- An experiment changes state
- A deadline approaches
- Evidence freshness changes
- A simulation completes
- A paper order is filled
- An approval is granted or denied
- STOP ALL is activated or deactivated

### 5.3 Expiry

The economic state expires when:
- The wake event's deadline passes
- The economic subsystem enters a terminal state
- The owner dismisses it

---

## 6. Economic state and authority

### 6.1 The economic state does not grant authority

A high-priority item in the economic state does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Perform real-money actions

### 6.2 The economic state influences ordering only

The economic state determines the order in which the economic subsystem
considers items. It does not change what the subsystem is allowed to do.

### 6.3 The economic state is always visible

The economic state is always visible to the owner. It is never hidden,
never fabricated, and never silently modified.

---

## 7. Economic state persistence

### 7.1 Derived state

The economic state is derived state. It is:
- Computed from durable state
- Journaled as metadata on change
- Never stored as a separate durable field
- Rebuilt on restart from the journal

### 7.2 Journal events

The economic state produces these event types:

| Event | Purpose |
|---|---|
| `economic.state.computed` | The economic state was computed |
| `economic.state.updated` | The economic state was updated |
| `economic.state.expired` | The economic state expired |
| `economic.experiment.ranked` | An experiment was ranked |
| `economic.experiment.blocked` | An experiment was blocked |
| `economic.experiment.escalated` | An experiment was escalated |
| `economic.action.recommended` | A next bounded action was recommended |

---

## 8. Economic state invariants

These invariants must hold at all times:

1. **Economic state is explainable** — Every item carries reasoning.
2. **Economic state is honest** — Uncertainty is never hidden.
3. **Economic state is bounded** — Lists and strings are bounded.
4. **Economic state is deterministic** — Same inputs + same clock = same state.
5. **Economic state does not grant authority** — Every action flows through existing authority.
6. **Economic state performs no real-money actions** — No real-money action is performed.
7. **Metrics have denominators** — Every metric has an explicit denominator.
