# Phase 39 — Fail-Closed Conditions

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Fail-closed conditions are the conditions under which the system must refuse,
deny, halt, or suspend rather than proceed. The Mature Freya Threshold is
fail-closed: any ambiguity, uncertainty, or boundary violation results in
refusal, halt, or denial — never in assumed maturity.

**Phase 39 is a threshold to prove — not a license to widen authority.**
Fail-closed conditions ensure that maturity is never assumed, never
self-granted, and never used to widen authority.

---

## 2. Fail-closed principle

> **When in doubt, refuse. When uncertain, halt. When boundary violated, deny.**

The system fails closed, not open. Fail-closed means:

1. **Ambiguity → Refuse.** If the system cannot determine whether an action
   is authorized, it refuses.
2. **Uncertainty → Halt.** If the system cannot verify an outcome, it halts
   and surfaces uncertainty.
3. **Boundary violation → Deny.** If an action would violate a boundary, it
   is denied.
4. **Evidence insufficient → Wait.** If evidence is insufficient, the system
   waits for more evidence rather than assuming maturity.
5. **Evidence fabricated → Suspend.** If evidence is fabricated, the system
   suspends the threshold.

---

## 3. Fail-closed condition kinds

### 3.1 Ambiguity

**Trigger:** The system cannot determine whether an action is authorized.

**Examples:**
- Wake source is ambiguous
- Approval requirement is ambiguous
- Budget boundary is ambiguous
- Capability boundary is ambiguous

**Action:** REFUSE — the action is not performed. The ambiguity is journaled
and surfaced to the owner.

**Resolution:** The owner clarifies the ambiguity. The system re-evaluates.

### 3.2 Uncertainty

**Trigger:** The system cannot verify an outcome or state.

**Examples:**
- Outcome cannot be verified
- Evidence is stale or conflicting
- Provider failure prevents verification
- State is ambiguous after restart

**Action:** HALT — the system halts and surfaces uncertainty. No maturity is
assumed. The uncertainty is journaled.

**Resolution:** The uncertainty is resolved through evidence collection,
owner clarification, or explicit acceptance of uncertainty.

### 3.3 Boundary violation

**Trigger:** An action would violate a boundary.

**Examples:**
- Capability escalation attempt
- Authority drift attempt
- Budget exceeded
- Approval skipped
- Self-modification attempt
- Real-money action attempt

**Action:** DENY — the action is denied. The violation is journaled and
surfaced to the owner.

**Resolution:** The boundary is not widened. The action is not performed.

### 3.4 Evidence insufficient

**Trigger:** Evidence is insufficient to prove a maturity criterion.

**Examples:**
- Test has not been run
- Test result is inconclusive
- Evidence has expired
- Evidence source is unverified

**Action:** WAIT — the system waits for more evidence. No maturity is
assumed. The insufficiency is journaled.

**Resolution:** Evidence is collected, verified, and journaled. The criterion
is re-assessed.

### 3.5 Evidence fabricated

**Trigger:** Evidence is fabricated or forged.

**Examples:**
- Test result is fabricated
- Evidence source is forged
- Journal entry is fabricated
- State is fabricated on restart

**Action:** SUSPEND — the threshold is suspended. The fabrication is
journaled and surfaced to the owner.

**Resolution:** The fabrication is investigated. The threshold remains
suspended until the owner explicitly re-assesses.

### 3.6 Authority drift

**Trigger:** Authority drift is detected.

**Examples:**
- Capability is widened beyond code-owned ceiling
- Guard is bypassed
- Governor is bypassed
- STOP ALL is cleared
- Budget is exceeded
- Approval is skipped
- Grant is created without owner
- Self-modification occurs

**Action:** SUSPEND — the threshold is suspended. The drift is journaled
and surfaced to the owner.

**Resolution:** The drift is investigated. The boundary is restored. The
threshold remains suspended until the owner explicitly re-assesses.

### 3.7 Self-modification

**Trigger:** An attempt to self-modify trusted runtime code.

**Examples:**
- Code attempts to modify itself
- Code attempts to modify Guard
- Code attempts to modify Governor
- Code attempts to modify STOP ALL
- Code attempts to modify budgets
- Code attempts to modify approvals

**Action:** SUSPEND — the threshold is suspended. The attempt is journaled
and surfaced to the owner.

**Resolution:** The attempt is refused. No self-modification occurs. The
threshold remains suspended until the owner explicitly re-assesses.

### 3.8 STOP ALL

**Trigger:** STOP ALL is activated.

**Examples:**
- Owner activates STOP ALL
- Emergency stop is triggered

**Action:** HALT — all activity halts immediately. The halt is journaled.

**Resolution:** The owner deactivates STOP ALL. The system resumes from
the journal.

---

## 4. Fail-closed decision matrix

| Condition | Action | State transition | Journaled | Owner notified |
|---|---|---|---|---|
| Ambiguity | REFUSE | → UNPROVEN | Yes | Yes |
| Uncertainty | HALT | → SUSPENDED | Yes | Yes |
| Boundary violation | DENY | → SUSPENDED | Yes | Yes |
| Evidence insufficient | WAIT | → UNPROVEN | Yes | No |
| Evidence fabricated | SUSPEND | → SUSPENDED | Yes | Yes |
| Authority drift | SUSPEND | → SUSPENDED | Yes | Yes |
| Self-modification | SUSPEND | → SUSPENDED | Yes | Yes |
| STOP ALL | HALT | → SUSPENDED | Yes | Yes |

---

## 5. Fail-closed invariants

These invariants must hold at all times:

1. **Fail-closed is default.** The system fails closed, not open.
2. **No assumed maturity.** Maturity is never assumed without evidence.
3. **No self-granted maturity.** Maturity is never self-granted.
4. **No authority widening.** Fail-closed conditions never widen authority.
5. **All fail-closed decisions are journaled.** Every refusal, halt, denial,
   and suspension is durable.
6. **All fail-closed decisions are surfaced.** The owner is notified of every
   fail-closed decision.
7. **Fail-closed is deterministic.** Same condition + same state = same
   fail-closed decision.
8. **Fail-closed is bounded.** Every fail-closed decision completes within a
   deadline.

---

## 6. Fail-closed and the threshold rule

> **Phase 39 is a threshold to prove — not a license to widen authority.**

Fail-closed conditions enforce the threshold rule:

1. Maturity is proven, not declared. Fail-closed prevents assumed maturity.
2. Maturity does not widen authority. Fail-closed prevents authority widening.
3. Maturity is not permanent. Fail-closed suspends maturity on any violation.
4. Maturity is owner-controlled. Fail-closed surfaces violations to the owner.
5. Maturity is fail-closed. Fail-closed is the default, not the exception.
