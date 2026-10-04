# Phase 38 — Evidence-Driven Improvement Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Evidence-driven improvement is the process of improving planning, reasoning,
and learning based on verified evidence. No improvement is made without
evidence. No evidence is fabricated.

---

## 2. Evidence-driven improvement process

### 2.1 Steps

1. **Collect** — collect evidence from verified sources
2. **Verify** — verify evidence quality and provenance
3. **Assess** — assess whether evidence is sufficient for improvement
4. **Propose** — propose improvement based on evidence
5. **Evaluate** — evaluate the proposed improvement
6. **Apply** — apply the improvement (if authorized)

### 2.2 Constraints

- Evidence-driven improvement never fabricates evidence
- Evidence-driven improvement never exceeds authority
- Evidence-driven improvement always respects STOP ALL
- Evidence-driven improvement never self-modifies trusted runtime code

---

## 3. Evidence quality

### 3.1 Quality levels

| Level | Meaning |
|---|---|
| `insufficient` | Not enough evidence to support improvement |
| `weak` | Weak evidence, improvement not recommended |
| `moderate` | Moderate evidence, improvement possible with caution |
| `strong` | Strong evidence, improvement recommended |
| `verified` | Verified evidence, improvement safe to apply |

### 3.2 Quality properties

- Quality is explicit — no implicit quality
- Quality is code-owned — it cannot be widened at runtime
- Quality is enforced — every improvement is checked against quality
- Quality is journaled — every quality assessment is durable

---

## 4. Evidence verification

### 4.1 Verification process

To verify evidence:
1. The evidence source is checked
2. The evidence provenance is verified
3. The evidence freshness is checked
4. The evidence quality is assessed
5. The verification is journaled

### 4.2 Verification properties

- Verification is deterministic — same evidence + same source = same result
- Verification is bounded — it completes within a deadline
- Verification is journaled — every verification is durable
- Verification never calls a model
- Verification never fabricates results

---

## 5. Evidence-driven improvement and authority

### 5.1 Evidence-driven improvement does not grant authority

Evidence-driven improvement does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Self-modify trusted runtime code

### 5.2 Evidence-driven improvement influences improvement only

Evidence-driven improvement determines whether an improvement can be made.
It does not change what the subsystem is allowed to do.

---

## 6. Evidence-driven improvement persistence

### 6.1 Durable storage

Evidence and improvement records are stored in Vault. They survive restarts.
They are event-sourced — all changes are journaled.

### 6.2 Recovery

On restart:
1. Replay the journal
2. Rebuild evidence and improvement state
3. Reconcile interrupted improvements
4. Resume or terminate explicitly

---

## 7. Evidence-driven improvement invariants

These invariants must hold at all times:

1. **Evidence-driven improvement is bounded** — Every improvement has a deadline.
2. **Evidence-driven improvement is deterministic** — Same evidence = same improvement.
3. **Evidence-driven improvement is journaled** — Every improvement is durable.
4. **Evidence-driven improvement does not grant authority** — Every action flows through existing authority.
5. **Evidence-driven improvement never fabricates evidence** — Evidence is always derived from verified sources.
6. **Evidence-driven improvement never self-modifies** — Trusted runtime code is never self-modified.
