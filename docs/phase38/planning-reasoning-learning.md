# Phase 38 — Planning / Reasoning / Learning Improvement Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Planning / reasoning / learning improvement is the evidence-driven improvement
of Freya's planning, reasoning, and learning capabilities. It extends the
existing Experience → Knowledge → Skill architecture (Phase 28) to provide
explicit improvement tracking and verification.

---

## 2. Improvement process

### 2.1 Steps

1. **Identify** — identify the improvement area (planning, reasoning, learning)
2. **Collect** — collect evidence for improvement
3. **Verify** — verify evidence quality
4. **Propose** — propose the improvement
5. **Evaluate** — evaluate the improvement
6. **Stage** — stage the improvement for review
7. **Apply** — apply the improvement (if authorized)
8. **Verify** — verify the improvement outcome

### 2.2 Constraints

- Improvement never fabricates certainty
- Improvement always surfaces uncertainty
- Improvement never exceeds authority
- Improvement always respects STOP ALL
- Improvement never self-modifies trusted runtime code

---

## 3. Improvement areas

### 3.1 Planning improvement

Improvement of Freya's planning capabilities.

**Properties:**
- Based on verified evidence
- Bounded by deadlines
- Auditable
- Reversible
- Never self-modifies trusted runtime code

### 3.2 Reasoning improvement

Improvement of Freya's reasoning capabilities.

**Properties:**
- Based on verified evidence
- Bounded by deadlines
- Auditable
- Reversible
- Never self-modifies trusted runtime code

### 3.3 Learning improvement

Improvement of Freya's learning capabilities.

**Properties:**
- Based on verified evidence
- Bounded by deadlines
- Auditable
- Reversible
- Never self-modifies trusted runtime code

---

## 4. Improvement lifecycle

### 4.1 States

| State | Description | Terminal? |
|---|---|---|
| `proposed` | Improvement is proposed | No |
| `evaluating` | Improvement is being evaluated | No |
| `approved` | Improvement is approved | No |
| `staged` | Improvement is staged for review | No |
| `applied` | Improvement is applied | Yes |
| `failed` | Improvement failed | Yes |

### 4.2 Transitions

| From | To | Condition |
|---|---|---|
| `proposed` | `evaluating` | Evaluation starts |
| `proposed` | `failed` | Evidence insufficient |
| `evaluating` | `approved` | Evaluation passes |
| `evaluating` | `failed` | Evaluation fails |
| `approved` | `staged` | Improvement is staged |
| `approved` | `failed` | Staging fails |
| `staged` | `applied` | Owner approves and improvement is applied |
| `staged` | `failed` | Application fails |
| `applied` | — | Terminal |
| `failed` | — | Terminal |

---

## 5. Improvement and authority

### 5.1 Improvement does not grant authority

Improvement does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Self-modify trusted runtime code

### 5.2 Improvement influences capability only

Improvement determines what Freya can do within her existing authority. It
does not change what she is allowed to do.

---

## 6. Improvement persistence

### 6.1 Durable storage

Improvement records are stored in Vault. They survive restarts. They are
event-sourced — all changes are journaled.

### 6.2 Recovery

On restart:
1. Replay the journal
2. Rebuild improvement state
3. Reconcile interrupted improvements
4. Resume or terminate explicitly

---

## 7. Improvement invariants

These invariants must hold at all times:

1. **Improvement is bounded** — Every improvement has a deadline.
2. **Improvement is deterministic** — Same evidence = same improvement.
3. **Improvement is journaled** — Every improvement is durable.
4. **Improvement does not grant authority** — Every action flows through existing authority.
5. **Improvement never self-modifies** — Trusted runtime code is never self-modified.
6. **Improvement is evidence-driven** — Every improvement is based on verified evidence.
7. **Improvement is reversible** — Improvements can be rolled back.
