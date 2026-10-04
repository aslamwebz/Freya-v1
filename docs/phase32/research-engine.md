# Phase 32 — Research Engine Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

The Research Engine is the subsystem that enables Freya to research
market/business opportunities, gather evidence, and structure that evidence
with provenance and citations. It is bounded, deterministic and explainable.

---

## 2. Research process

### 2.1 Steps

1. **Define** — define the research question and scope
2. **Gather** — gather evidence from authorized sources
3. **Structure** — structure evidence with provenance and citations
4. **Assess** — evaluate completeness, freshness, conflicts
5. **Report** — produce a bounded, explainable research report

### 2.2 Constraints

- Research never fabricates certainty
- Research always surfaces uncertainty
- Research never exceeds authority
- Research always respects STOP ALL
- Research never performs real-money actions

---

## 3. Evidence

### 3.1 Definition

Evidence is a structured record of an observation from an authorized source.
Each piece of evidence has:
- A unique identifier
- An experiment reference
- A source (authorized source id, never free text)
- A citation (bounded, human-readable)
- An observation timestamp
- A freshness/conflict state
- A confidence level

### 3.2 Properties

- Evidence is explicit — no implicit evidence
- Evidence is bounded — at most 128 pieces per experiment
- Evidence is sourced — every piece has an authorized source
- Evidence is cited — every piece has a citation
- Evidence is fresh — staleness is tracked
- Evidence is honest — conflicts are preserved

### 3.3 Evidence states

| State | Meaning |
|---|---|
| `fresh` | Recently observed, no conflicts |
| `stale` | May be outdated, staleness threshold exceeded |
| `conflicted` | Multiple sources disagree |
| `missing` | Needed but not available |

---

## 4. Research and authority

### 4.1 Research does not grant authority

Research does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Perform real-money actions

### 4.2 Research influences planning only

Research determines what the economic subsystem knows. It does not change
what the subsystem is allowed to do.

---

## 5. Research and uncertainty

### 5.1 Missing information

When information is missing:
1. The gap is recorded explicitly
2. An assumption is created (if needed)
3. The research proceeds with the gap marked

### 5.2 Stale information

When information is stale:
1. It is marked as stale
2. Its confidence is reduced
3. The research is adjusted

### 5.3 Conflicted information

When information is conflicted:
1. Both versions are preserved
2. The conflict is recorded
3. The more conservative interpretation is used
4. The owner is notified

---

## 6. Research persistence

### 6.1 Durable storage

Research is stored in Vault. It survives restarts. It is event-sourced —
all changes are journaled.

### 6.2 Recovery

On restart:
1. Replay the journal
2. Rebuild research state
3. Reconcile interrupted research
4. Resume or terminate explicitly

---

## 7. Research invariants

These invariants must hold at all times:

1. **Research is bounded** — Every research question has a scope and deadline.
2. **Research is sourced** — Every piece of evidence has an authorized source.
3. **Research is cited** — Every piece of evidence has a citation.
4. **Research is honest** — Uncertainty is never hidden.
5. **Research does not grant authority** — Every action flows through existing authority.
6. **Research performs no real-money actions** — No real-money action is performed.
