# Phase 39 — Rollback Criteria

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Rollback criteria define when and how to roll back the Mature Freya Threshold.
Rollback is the process of revoking a `proven` threshold and returning to
`unproven` or `rolled-back` state.

**Phase 39 is a threshold to prove — not a license to widen authority.**
Rollback ensures that maturity can be revoked when it is no longer valid,
when boundaries are violated, or when the owner decides to revoke it.

---

## 2. Rollback principle

> **Maturity is revocable. Rollback is owner-controlled. Rollback is
> auditable. Rollback never widens authority.**

Rollback is:

1. **Owner-controlled** — only the owner may initiate rollback
2. **Auditable** — every rollback is journaled
3. **Bounded** — rollback completes within a deadline
4. **Deterministic** — same condition + same state = same rollback decision
5. **Non-widening** — rollback never widens authority

---

## 3. Rollback reasons

### 3.1 Authority widening

**Trigger:** Authority widening is detected.

**Examples:**
- Capability is widened beyond code-owned ceiling
- Guard is bypassed
- Governor is bypassed
- STOP ALL is cleared
- Budget is exceeded
- Approval is skipped
- Grant is created without owner

**Action:** Rollback is initiated. The threshold is revoked. The widening
is reversed. The rollback is journaled.

**Owner approval:** Required.

### 3.2 Hidden inference

**Trigger:** Hidden inference is detected.

**Examples:**
- Model call without a wake
- Continuous polling
- Hidden reasoning
- Background processing
- Self-scheduling timers

**Action:** Rollback is initiated. The threshold is revoked. The hidden
inference is stopped. The rollback is journaled.

**Owner approval:** Required.

### 3.3 Real-money action

**Trigger:** A real-money action is attempted or performed.

**Examples:**
- Real-money trading
- Real spending
- Real financial transactions
- Real orders placed

**Action:** Rollback is initiated. The threshold is revoked. The real-money
action is refused. The rollback is journaled.

**Owner approval:** Required.

### 3.4 Fabricated evidence

**Trigger:** Fabricated evidence is detected.

**Examples:**
- Test result is fabricated
- Evidence source is forged
- Journal entry is fabricated
- State is fabricated on restart

**Action:** Rollback is initiated. The threshold is revoked. The fabricated
evidence is removed. The rollback is journaled.

**Owner approval:** Required.

### 3.5 Unverifiable maturity

**Trigger:** Maturity cannot be verified.

**Examples:**
- Evidence is insufficient
- Evidence has expired
- Evidence source is unverified
- Test results are inconclusive

**Action:** Rollback is initiated. The threshold is revoked. The maturity
is marked as unproven. The rollback is journaled.

**Owner approval:** Required.

### 3.6 Boundary violation

**Trigger:** A boundary violation is detected.

**Examples:**
- Capability escalation
- Authority drift
- Self-modification
- Privacy violation
- Security violation

**Action:** Rollback is initiated. The threshold is revoked. The boundary
is restored. The rollback is journaled.

**Owner approval:** Required.

### 3.7 Owner-requested

**Trigger:** The owner requests rollback.

**Examples:**
- Owner decides maturity is no longer valid
- Owner wants to re-assess maturity
- Owner wants to suspend the threshold

**Action:** Rollback is initiated. The threshold is revoked. The rollback
is journaled.

**Owner approval:** Required (the owner is the one requesting).

---

## 4. Rollback process

### 4.1 Steps

1. **Detect** — detect the rollback condition
2. **Verify** — verify the rollback condition
3. **Request** — request owner approval
4. **Approve** — owner approves the rollback
5. **Execute** — execute the rollback
6. **Journal** — journal the rollback
7. **Verify** — verify the rollback completed

### 4.2 Constraints

- Rollback is owner-controlled — only the owner may initiate rollback
- Rollback is auditable — every rollback is journaled
- Rollback is bounded — it completes within a deadline
- Rollback is deterministic — same condition + same state = same rollback
- Rollback never widens authority
- Rollback never self-modifies trusted runtime code
- Rollback never bypasses Guard, Governor, STOP ALL, approvals or budgets

---

## 5. Rollback state transitions

| From | To | Condition |
|---|---|---|
| `PROVEN` | `ROLLED_BACK` | Rollback executed |
| `SUSPENDED` | `ROLLED_BACK` | Rollback executed |
| `UNPROVEN` | `ROLLED_BACK` | Rollback executed (no-op) |
| `ASSESSING` | `ROLLED_BACK` | Rollback executed |
| `EVIDENCING` | `ROLLED_BACK` | Rollback executed |
| `EVALUATING` | `ROLLED_BACK` | Rollback executed |
| `ROLLED_BACK` | — | Terminal |

---

## 6. Rollback and the threshold rule

> **Phase 39 is a threshold to prove — not a license to widen authority.**

Rollback enforces the threshold rule:

1. Maturity is proven, not declared. Rollback revokes declared maturity
   that is not evidence-backed.
2. Maturity does not widen authority. Rollback reverses any authority
   widening.
3. Maturity is not permanent. Rollback revokes maturity when it is no
   longer valid.
4. Maturity is owner-controlled. Rollback is owner-controlled.
5. Maturity is fail-closed. Rollback is the ultimate fail-closed action.

---

## 7. Rollback invariants

These invariants must hold at all times:

1. **Rollback is owner-controlled** — only the owner may initiate rollback.
2. **Rollback is auditable** — every rollback is journaled.
3. **Rollback is bounded** — rollback completes within a deadline.
4. **Rollback is deterministic** — same condition + same state = same rollback.
5. **Rollback never widens authority** — rollback only revokes, never widens.
6. **Rollback never self-modifies** — trusted runtime code is never self-modified.
7. **Rollback never bypasses authority** — rollback flows through Guard,
   Governor, STOP ALL, approvals and budgets.
8. **Rollback is reversible** — maturity can be re-proven after rollback.
