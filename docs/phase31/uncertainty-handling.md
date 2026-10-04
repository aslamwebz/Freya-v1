# Phase 31 — Uncertainty Handling

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

The long-horizon subsystem must plan and make decisions even when information
is incomplete, stale, or conflicted. This document defines how the subsystem
handles uncertainty without fabricating certainty.

---

## 2. Types of uncertainty

### 2.1 Missing information

Information that is needed but not available.

**Handling:** The assumption is recorded explicitly. The plan proceeds
with the assumption marked as unverified.

### 2.2 Stale information

Information that was accurate but may no longer be current.

**Handling:** The information's age is tracked. When it exceeds a
code-owned threshold, it is marked as stale and the plan is adjusted.

### 2.3 Conflicted information

Multiple sources provide contradictory information.

**Handling:** Both versions are preserved. The conflict is surfaced
to the owner. The plan uses the more conservative interpretation.

### 2.4 Unknown information

Information that is not known to exist.

**Handling:** The plan includes explicit "unknown" markers. These
are surfaced in the long-horizon state.

---

## 3. Assumptions

### 3.1 Definition

An assumption is a statement accepted as true for planning purposes
without verification.

### 3.2 Properties

Every assumption has:
- A unique identifier
- A goal reference
- A statement
- A confidence level (`high`, `medium`, `low`, `unknown`)
- An expiration time
- A source (who/what created it)
- A status (active, confirmed, refuted, expired)

### 3.3 Lifecycle

1. **Created** — when planning encounters missing information
2. **Active** — used in planning decisions
3. **Confirmed** — confirmed by evidence
4. **Refuted** — contradicted by evidence
5. **Expired** — past its expiration time

### 3.4 Constraints

- Assumptions must be explicit — no implicit assumptions
- Assumptions must have expiration times
- Assumptions must be surfaced in the long-horizon state
- Assumptions cannot override owner directives
- Assumptions cannot grant authority

---

## 4. Confidence

### 4.1 Definition

Confidence is a measure of how much the subsystem trusts a
particular piece of information or plan.

### 4.2 Levels

| Level | Meaning |
|---|---|
| `high` | Multiple independent sources agree |
| `medium` | Single reliable source |
| `low` | Single uncertain source |
| `unknown` | No source or conflicting sources |

### 4.3 Computation

Confidence is computed from:
- Source reliability
- Evidence freshness
- Source agreement
- Verification status

### 4.4 Constraints

- Confidence is never 100% — there is always some uncertainty
- Confidence is never fabricated — it is always derived from evidence
- Confidence is always explainable — traceable to its inputs

---

## 5. Stale evidence

### 5.1 Definition

Evidence that was accurate when collected but may no longer reflect
current reality.

### 5.2 Detection

Evidence freshness is tracked by:
- Collection timestamp
- Source update frequency
- Explicit invalidation events

### 5.3 Handling

When evidence is stale:
1. It is marked as stale
2. Its confidence is reduced
3. The plan is adjusted to account for potential changes
4. The owner is notified if the staleness affects critical decisions

### 5.4 Thresholds

| Evidence type | Staleness threshold |
|---|---|
| Real-time state | 5 minutes |
| Recent events | 1 hour |
| Historical data | 24 hours |
| Static configuration | 30 days |

---

## 6. Conflicted evidence

### 6.1 Definition

Multiple sources provide contradictory information about the same fact.

### 6.2 Handling

When evidence conflicts:
1. Both versions are preserved with their sources
2. The conflict is recorded
3. The more conservative interpretation is used for planning
4. The owner is notified

### 6.3 Resolution

Conflicts are resolved by:
1. New evidence that supports one version
2. Owner directive
3. Time (if one version becomes stale)

---

## 7. Reversible decisions

### 7.1 Definition

A decision that can be undone or modified without significant cost.

### 7.2 Properties

Every decision has:
- A reversibility assessment
- A rollback plan (if reversible)
- A cost estimate (if irreversible)

### 7.3 Constraints

- Irreversible decisions require owner approval
- Reversible decisions can be made autonomously within authority
- All decisions are logged with their reversibility assessment

---

## 8. Planning process

### 8.1 Steps

1. **Gather** — collect available information
2. **Assess** — evaluate completeness, freshness, conflicts
3. **Assume** — create explicit assumptions for gaps
4. **Plan** — develop a plan using available information
5. **Mark** — flag uncertain elements
6. **Execute** — carry out the plan within authority
7. **Verify** — check outcomes against expectations
8. **Adjust** — update assumptions and plans based on results

### 8.2 Constraints

- Planning never fabricates certainty
- Planning always surfaces uncertainty
- Planning never exceeds authority
- Planning always respects STOP ALL

---

## 9. Long-horizon state

### 9.1 What it shows

The long-horizon state answers:
- What is being pursued now
- Why it matters
- What is blocked
- What is uncertain
- Next bounded action

### 9.2 Uncertainty representation

Uncertainty is shown as:
- Confidence levels on items
- Explicit assumption lists
- Staleness indicators
- Conflict markers
- "Unknown" markers

### 9.3 Constraints

- The long-horizon state never hides uncertainty
- The long-horizon state never fabricates confidence
- The long-horizon state is always explainable

---

## 10. Uncertainty and authority

### 10.1 Uncertainty does not grant authority

An uncertain goal does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements

### 10.2 Uncertainty influences planning only

Uncertainty determines how the subsystem plans. It does not change what the
subsystem is allowed to do.

---

## 11. Uncertainty invariants

These invariants must hold at all times:

1. **Uncertainty is explicit** — No implicit assumptions.
2. **Uncertainty is bounded** — Assumptions have expiration times.
3. **Uncertainty is surfaced** — The long-horizon state shows uncertainty.
4. **Uncertainty is honest** — Confidence is never fabricated.
5. **Uncertainty does not grant authority** — Every action flows through existing authority.
